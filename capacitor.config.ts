import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.forwardx.app',
  appName: 'ForwardX',
  webDir: 'client/dist',
  server: {
    androidScheme: 'http',
    cleartext: true,
  },
  android: {
    backgroundColor: '#f7f9fc',
  },
  ios: {
    // CSS already owns the safe-area insets; avoid applying them twice.
    contentInset: 'never',
    allowsBackForwardNavigationGestures: true,
  },
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_forwardx',
      iconColor: '#2563eb',
    },
  },
};

export default config;
