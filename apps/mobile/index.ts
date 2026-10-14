// Polyfills first: viem needs crypto.getRandomValues.
import 'react-native-get-random-values';
import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
