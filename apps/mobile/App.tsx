import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { NavigationContainer, DarkTheme, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'react-native';
import { SessionProvider, useSession } from './src/lib/session';
import { SignInScreen, SignUpScreen } from './src/screens/Auth';
import { AppealHoldScreen, HistoryScreen, HomeScreen, ReceiveScreen, SendScreen } from './src/screens/Wallet';
import { PaymentScreen, PaymentsScreen, TradeScreen } from './src/screens/Protected';
import { SettingsScreen, SupportScreen, VerifyScreen } from './src/screens/Account';
import { InvoicesScreen, OrdersScreen, P2PScreen, RecoverScreen, ReportScreen } from './src/screens/Loops';

const Stack = createNativeStackNavigator();
const Tabs = createBottomTabNavigator();

function MainTabs({ navigation }: { navigation: any }) {
  const { me } = useSession();
  const go = (screen: string, params?: Record<string, string>) => navigation.navigate(screen, params);
  return (
    <Tabs.Navigator screenOptions={{ headerShown: false, tabBarLabelStyle: { fontSize: 13 } }}>
      <Tabs.Screen name="Home" options={{ tabBarAccessibilityLabel: 'Home' }}>
        {() => <HomeScreen go={go} />}
      </Tabs.Screen>
      <Tabs.Screen name="History" component={HistoryScreen} />
      <Tabs.Screen name="Payments" options={{ title: 'Protected' }}>
        {() => <PaymentsScreen open={(id) => (id.startsWith('trade:') ? go('Trade', { id: id.slice(6) }) : go('Payment', { id }))} />}
      </Tabs.Screen>
      <Tabs.Screen name="Invoices">{() => <InvoicesScreen open={(id) => go('Payment', { id })} />}</Tabs.Screen>
      <Tabs.Screen name="P2P">{() => <P2PScreen openTrade={(id) => go('Trade', { id })} />}</Tabs.Screen>
      {me?.tier === 'none' ? <Tabs.Screen name="Verify" component={VerifyScreen} /> : null}
      <Tabs.Screen name="Settings" component={SettingsScreen} />
    </Tabs.Navigator>
  );
}

function Root() {
  const { me, loading } = useSession();
  const [mode, setMode] = useState<'signin' | 'signup' | 'recover'>('signin');
  const scheme = useColorScheme();
  if (loading)
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator accessibilityLabel="Loading" />
      </View>
    );
  return (
    <NavigationContainer theme={scheme === 'dark' ? DarkTheme : DefaultTheme}>
      <StatusBar style="auto" />
      {!me ? (
        mode === 'signup' ? (
          <SignUpScreen onBack={() => setMode('signin')} />
        ) : mode === 'recover' ? (
          <RecoverScreen onBack={() => setMode('signin')} />
        ) : (
          <SignInScreen onSignUp={() => setMode('signup')} onRecover={() => setMode('recover')} />
        )
      ) : (
        <Stack.Navigator>
          <Stack.Screen name="Main" component={MainTabs} options={{ headerShown: false }} />
          <Stack.Screen name="Send">{({ navigation }) => <SendScreen done={() => navigation.goBack()} />}</Stack.Screen>
          <Stack.Screen name="Receive" component={ReceiveScreen} />
          <Stack.Screen name="Payment">{({ route }) => <PaymentScreen id={(route.params as { id: string }).id} />}</Stack.Screen>
          <Stack.Screen name="Trade">{({ route }) => <TradeScreen id={(route.params as { id: string }).id} />}</Stack.Screen>
          <Stack.Screen name="Appeal">{({ route, navigation }) => <AppealHoldScreen transferId={(route.params as { transferId: string }).transferId} done={() => navigation.goBack()} />}</Stack.Screen>
          <Stack.Screen name="Support" component={SupportScreen} />
          <Stack.Screen name="Orders">{({ navigation }) => <OrdersScreen open={(id) => navigation.navigate('Payment', { id })} />}</Stack.Screen>
          <Stack.Screen name="Report" component={ReportScreen} />
        </Stack.Navigator>
      )}
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <Root />
      </SessionProvider>
    </SafeAreaProvider>
  );
}
