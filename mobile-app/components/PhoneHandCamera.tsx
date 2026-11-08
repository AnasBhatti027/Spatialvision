import React, { memo, useEffect, useRef, useState } from 'react';
import { PermissionsAndroid, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

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

export const phoneCameraAvailable = Platform.OS === 'android' && !!MP && typeof MP.useMediaPipe === 'function';

type Theme = { text: string; mute: string; cyan: string; err: string; line: string; s2: string; blue: string };
type Props = { T: Theme; send: (msg: object) => boolean };

const ROTATIONS = [0, 90, 180, 270];
const r4 = (v: number) => Math.round(v * 10000) / 10000;

/** Keeps the screen on while the phone is the camera (it sits on a stand, nobody touches it). */
function KeepAwake() { useKeepAwake?.(); return null; }

/** The camera itself. Only mounted when the native module exists and permission is granted. */
const Tracker = memo(function Tracker({ T, send, mirror, rot, onError }: Props & { mirror: boolean; rot: number; onError: (m: string) => void }) {
  // The hook may keep the first callbacks it is given, so everything they use is read through refs.
  const sendRef = useRef(send); sendRef.current = send;
  const cfg = useRef({ mirror, rot }); cfg.current = { mirror, rot };
  const errRef = useRef(onError); errRef.current = onError;
  const [fps, setFps] = useState<number | null>(null);

  const { status, startCamera, stopCamera, CameraView } = MP.useMediaPipe({
    task: 'handLandmarker',
    modelPath: 'hand_landmarker.task',
    maxResults: 1,
    minConfidence: 0.5,
    cameraFacing: 'front',
    delegate: 'gpu',
    onResults: (r: any) => {
      const hand = r?.landmarks?.[0];
      const flat = Array.isArray(hand) && hand.length === 21
        ? hand.flatMap((p: any) => [r4(Number(p.x)), r4(Number(p.y))])
        : null;
      sendRef.current({
        type: 'hand', pts: flat,
        w: r?.imageWidth ?? 0, h: r?.imageHeight ?? 0,
        mirror: cfg.current.mirror, rot: cfg.current.rot,
      });
    },
    onPerformance: (p: any) => { if (typeof p?.fps === 'number') setFps(Math.round(p.fps)); },
    onError: (e: any) => errRef.current(String(e?.message ?? e?.error ?? e ?? 'Camera error')),
  });

  useEffect(() => {
    if (status === 'ready') {
      Promise.resolve(startCamera?.()).catch((e: any) => errRef.current(String(e?.message ?? e)));
    }
  }, [status]);
  useEffect(() => () => { try { stopCamera?.(); } catch {} }, []);

  return (
    <View>
      <View style={[styles.preview, { borderColor: T.line }]}>
        {CameraView ? <CameraView style={StyleSheet.absoluteFill} /> : null}
      </View>
      <Text style={[styles.small, { color: T.mute }]}>
        {status === 'error' ? 'The hand tracker could not start.'
          : status !== 'ready' ? 'Loading the hand tracker…'
          : fps == null ? 'Camera starting…' : `Phone camera: ${fps} fps (measured on the phone)`}
      </Text>
    </View>
  );
});

export default function PhoneHandCamera({ T, send }: Props) {
  const [perm, setPerm] = useState<'asking' | 'granted' | 'denied'>('asking');
  const [mirror, setMirror] = useState(true); // front camera: mirror so moving right moves right
  const [rot, setRot] = useState(0);
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
      <Tracker T={T} send={send} mirror={mirror} rot={rot} onError={setError} />
      <View style={styles.row}>
        <Pressable onPress={() => setMirror((m) => !m)} accessibilityRole="button" accessibilityLabel="Mirror left and right">
          <Text style={[styles.chip, { color: mirror ? '#FFFFFF' : T.mute, backgroundColor: mirror ? T.blue : 'transparent', borderColor: mirror ? T.blue : T.line }]}>Mirror</Text>
        </Pressable>
        <Pressable onPress={() => setRot((r) => ROTATIONS[(ROTATIONS.indexOf(r) + 1) % 4])} accessibilityRole="button" accessibilityLabel="Turn the camera picture">
          <Text style={[styles.chip, { color: T.mute, borderColor: T.line }]}>Turn {rot}°</Text>
        </Pressable>
      </View>
      <Text style={[styles.small, { color: T.mute }]}>
        Put the phone on a stand facing you. If the pointer moves the wrong way, tap Mirror; if up and down are swapped, tap Turn.
      </Text>
      {error ? <Text style={[styles.small, { color: T.err }]}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  preview: { height: 180, borderRadius: 14, borderWidth: 1, overflow: 'hidden', backgroundColor: '#000' },
  small: { fontSize: 12, lineHeight: 17, marginTop: 8 },
  row: { flexDirection: 'row', gap: 8, marginTop: 10 },
  chip: { borderWidth: 1, borderRadius: 18, paddingVertical: 8, paddingHorizontal: 14, overflow: 'hidden', fontSize: 13 },
});
