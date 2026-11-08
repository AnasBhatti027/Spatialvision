import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationBar } from 'expo-navigation-bar';
import SpatialVisionHome from './components/SpatialVisionHome';

export default function App() {
  return (
    <SafeAreaProvider>
      <NavigationBar hidden />
      <SpatialVisionHome />
    </SafeAreaProvider>
  );
}