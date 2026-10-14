// L1-5: push notifications for incoming funds, holds and final status of sends.
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { api } from './api';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: false }),
});

export async function registerPush(): Promise<void> {
  if (!Device.isDevice) return;
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== 'granted') return;
  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
  const token = (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)).data;
  await api.post('/me/push-tokens', { token, platform: Platform.OS === 'ios' ? 'ios' : 'android' });
}
