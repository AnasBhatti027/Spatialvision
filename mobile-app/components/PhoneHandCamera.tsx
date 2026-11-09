import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { PermissionsAndroid, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BrandLoader } from './Brand';

/**
 * Uses THIS PHONE's front camera for hand tracking. MediaPipe runs on the phone (expo-mediapipe),
 * and only the 21 hand points are sent to the PC over the existing WebSocket (message type "hand"),
 * about 30 times a second. No video goes over Wi-Fi, and the PC webcam is not used.
 *
 * expo-mediapipe contains native code, so it only works in the SpatialVision development build,
 * not in Expo Go. In Expo Go this component explains that instead of crashing.
 */

// Loaded only if the native module is in this build.
let MP: any = null;
try { MP = require('expo-mediapipe'); } catch { MP = null; }
let useKeepAwake: (() => void) | null = null;
try { useKeepAwake = require('expo-keep-awake').useKeepAwake; } catch { useKeepAwake = null; }

export const phoneCameraAvailable = Platform.OS === 'android' && !!MP && !!MP.NativeCameraView;

type Theme = { text: string; mute: string; cyan: string; err: string; line: string; s2: string; blue: string };
type Props = { T: Theme; send: (msg: object) => boolean };

const ROTATIONS = [0, 90, 180, 270];
const KEY_DELEGATE = 'sv.handTrackerProcessor';
const r4 = (v: number) => Math.round(v * 10000) / 10000;

/** Keeps the screen on while the phone is the camera (it sits on a stand, nobody touches it). */
function KeepAwake() { useKeepAwake?.(); return null; }

/** The camera itself. Only mounted when the native module exists and permission is granted.
 *
 * Uses the package's camera view directly instead of its useMediaPipe hook: the hook stores every
 * result in React state, which re-rendered this component 15-30 times a second on the phone's main
 * JavaScript thread, the same thread that sends the hand points. Measured 9 Nov: the phone delivered
 * only ~15 frames a second with pauses up to 560 ms. Here a result is read from the flat number list
 * the native side sends and goes straight to the WebSocket; React only updates once a second. */
const Tracker = memo(function Tracker({ T, send, mirror, rot, delegate, onError }: Props & { mirror: boolean; rot: number; delegate: 'gpu' | 'cpu'; onError: (m: string) => void }) {
  const sendRef = useRef(send); sendRef.current = send;
  const cfg = useRef({ mirror, rot }); cfg.current = { mirror, rot };
  const errRef = useRef(onError); errRef.current = onError;
  const count = useRef(0);
  const [fps, setFps] = useState<number | null>(null);
  const [status, setStatus] = useState('loading');

  // Once a second: frames per second, measured on the phone.
  useEffect(() => {
    let last = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      setFps(Math.round((count.current * 1000) / Math.max(1, now - last)));
      count.current = 0; last = now;
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Stable handlers (created once), so the native camera view is never re-mounted.
  const handlers = useMemo(() => ({
    onResults: (e: any) => {
      const r = e?.nativeEvent ?? {};
      count.current++;
      let flat: number[] | null = null;
      if (Array.isArray(r.landmarksFlat) && (r.landmarksPerEntity ?? 21) === 21 && r.landmarksFlat.length >= 21 * (r.landmarksStride ?? 3)) {
        const st = r.landmarksStride ?? 3;
        flat = new Array(42);
        for (let i = 0; i < 21; i++) { flat[2 * i] = r4(r.landmarksFlat[i * st]); flat[2 * i + 1] = r4(r.landmarksFlat[i * st + 1]); }
      } else if (Array.isArray(r.landmarks?.[0]) && r.landmarks[0].length === 21) {
        flat = r.landmarks[0].flatMap((p: any) => [r4(Number(p.x)), r4(Number(p.y))]);
      }
      sendRef.current({
        type: 'hand', pts: flat, t: Date.now(), // phone's time of this frame, so Wi-Fi bursts do not jerk the pointer
        w: r.imageWidth ?? 0, h: r.imageHeight ?? 0,
        mirror: cfg.current.mirror, rot: cfg.current.rot,
      });
    },
    onError: (e: any) => { setStatus('error'); errRef.current(String(e?.nativeEvent?.message ?? 'Camera error')); },
    onStatusChange: (e: any) => setStatus(String(e?.nativeEvent?.status ?? 'ready')),
  }), []);

  const Camera = MP.NativeCameraView;
  return (
    <View>
      <View style={[styles.preview, { borderColor: T.line }]}>
        <Camera key={delegate} style={StyleSheet.absoluteFill} task="handLandmarker" modelPath="hand_landmarker.task"
          maxResults={1} minConfidence={0.4} cameraFacing="front" delegate={delegate}
          isCameraRunning inferenceEnabled streamId={0}
          onResults={handlers.onResults} onError={handlers.onError} onStatusChange={handlers.onStatusChange} />
        {!fps && status !== 'error' && (
          <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]} pointerEvents="none">
            <BrandLoader dark size={52} label="Starting the hand tracker…" />
          </View>
        )}
      </View>
      <Text style={[styles.small, { color: T.mute }]}>
        {status === 'error' ? 'The hand tracker could not start.'
          : !fps ? 'Starting the hand tracker…' : `Phone camera: ${fps} frames per second (measured on the phone)`}
      </Text>
    </View>
  );
});

export default function PhoneHandCamera({ T, send }: Props) {
  const [perm, setPerm] = useState<'asking' | 'granted' | 'denied'>('asking');
  const [mirror, setMirror] = useState(true); // front camera: mirror so moving right moves right
  const [rot, setRot] = useState(0);
  // Which part of the phone runs the hand tracking. The graphics chip (GPU) is usually faster, but on
  // some older phones the main processor (CPU) is. Compare the frames-per-second number; the choice is kept.
  const [delegate, setDelegate] = useState<'gpu' | 'cpu'>('gpu');
  useEffect(() => { AsyncStorage.getItem(KEY_DELEGATE).then((v) => { if (v === 'cpu' || v === 'gpu') setDelegate(v); }).catch(() => {}); }, []);
  const switchDelegate = () => setDelegate((d) => {
    const next = d === 'gpu' ? 'cpu' : 'gpu';
    AsyncStorage.setItem(KEY_DELEGATE, next).catch(() => {});
    return next;
  });
  const [error, setError] = useState('');

  useEffect(() => {
    if (!phoneCameraAvailable) return;
    PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA, {
      title: 'Camera for hand tracking',
      message: 'SpatialVision uses the front camera to follow your hand. Pictures stay on this phone; only hand points are sent to your PC.',
      buttonPositive: 'Allow',
    }).then((r) => setPerm(r === PermissionsAndroid.RESULTS.GRANTED ? 'granted' : 'denied'))
      .catch(() => setPerm('denied'));
  }, []);

  if (!phoneCameraAvailable) {
    return (
      <Text style={[styles.small, { color: T.err }]}>
        {Platform.OS !== 'android'
          ? 'Phone-camera hand tracking works on Android only.'
          : 'Phone-camera hand tracking needs the SpatialVision development build. Expo Go cannot run it.'}
      </Text>
    );
  }
  if (perm === 'asking') return <Text style={[styles.small, { color: T.mute }]}>Asking for camera permission…</Text>;
  if (perm === 'denied') {
    return (
      <Text style={[styles.small, { color: T.err }]}>
        Camera permission was refused. Allow it in Android Settings, Apps, SpatialVision, Permissions, then try again.
      </Text>
    );
  }

  return (
    <View style={{ marginTop: 12 }}>
      <KeepAwake />
      <Tracker T={T} send={send} mirror={mirror} rot={rot} delegate={delegate} onError={setError} />
      <View style={styles.row}>
        <Pressable onPress={() => setMirror((m) => !m)} accessibilityRole="button" accessibilityLabel="Mirror left and right">
          <Text style={[styles.chip, { color: mirror ? '#FFFFFF' : T.mute, backgroundColor: mirror ? T.blue : 'transparent', borderColor: mirror ? T.blue : T.line }]}>Mirror</Text>
        </Pressable>
        <Pressable onPress={() => setRot((r) => ROTATIONS[(ROTATIONS.indexOf(r) + 1) % 4])} accessibilityRole="button" accessibilityLabel="Turn the camera picture">
          <Text style={[styles.chip, { color: T.mute, borderColor: T.line }]}>Turn {rot}°</Text>
        </Pressable>
        <Pressable onPress={switchDelegate} accessibilityRole="button" accessibilityLabel={`Hand tracking runs on the ${delegate === 'gpu' ? 'graphics chip' : 'main processor'}. Tap to switch`}>
          <Text style={[styles.chip, { color: T.mute, borderColor: T.line }]}>Runs on {delegate === 'gpu' ? 'GPU' : 'CPU'}</Text>
        </Pressable>
      </View>
      <Text style={[styles.small, { color: T.mute }]}>
        Put the phone on a stand facing you, about an arm's length away, so your hand is clearly visible. If the pointer moves the wrong way, tap Mirror; if up and down are swapped, tap Turn. If it feels slow, tap GPU/CPU and keep whichever shows more frames per second.
      </Text>
      {error ? <Text style={[styles.small, { color: T.err }]}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  preview: { height: 180, borderRadius: 14, borderWidth: 1, overflow: 'hidden', backgroundColor: '#000' },
  small: { fontSize: 12, lineHeight: 17, marginTop: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  chip: { borderWidth: 1, borderRadius: 18, paddingVertical: 8, paddingHorizontal: 14, overflow: 'hidden', fontSize: 13 },
});
