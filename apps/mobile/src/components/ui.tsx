// Mobile UI kit. NFR Accessibility: every control has a screen-reader label and role, text scales
// with the system font size (allowFontScaling defaults on), touch targets are at least 48dp.
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, useColorScheme, View, type TextInputProps } from 'react-native';

export function useTheme() {
  const dark = useColorScheme() === 'dark';
  return dark
    ? { bg: '#121314', surface: '#1b1c1e', text: '#ecebe7', muted: '#a9aaae', border: '#34363a', brand: '#5fc49d', brandInk: '#0d1f18', warnBg: '#3a2d10', warn: '#f0c060', dangerBg: '#3d1a17', danger: '#ff8a80', okBg: '#173322', ok: '#7fd49c', infoBg: '#1a2a40' }
    : { bg: '#f6f5f1', surface: '#ffffff', text: '#1b1c1e', muted: '#55575c', border: '#d9d6cd', brand: '#1b5e48', brandInk: '#ffffff', warnBg: '#fff4dc', warn: '#8a5a00', dangerBg: '#fde8e6', danger: '#b3261e', okBg: '#e1f3e7', ok: '#1b6e3c', infoBg: '#e5eefb' };
}

export function Screen({ children, title }: { children: ReactNode; title?: string }) {
  const t = useTheme();
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
      {title ? (
        <Text accessibilityRole="header" style={[s.h1, { color: t.text }]}>
          {title}
        </Text>
      ) : null}
      {children}
    </ScrollView>
  );
}

export function Card({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <View style={[s.card, { backgroundColor: t.surface, borderColor: t.border }]}>{children}</View>;
}

export function T({ children, muted, bold, size, style }: { children: ReactNode; muted?: boolean; bold?: boolean; size?: number; style?: object }) {
  const t = useTheme();
  return <Text style={[{ color: muted ? t.muted : t.text, fontWeight: bold ? '700' : '400', fontSize: size ?? 16, lineHeight: (size ?? 16) * 1.4 }, style]}>{children}</Text>;
}

export function Button({ label, onPress, kind = 'primary', disabled, busy }: { label: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; busy?: boolean }) {
  const t = useTheme();
  const bg = kind === 'primary' ? t.brand : kind === 'danger' ? t.danger : t.surface;
  const fg = kind === 'primary' ? t.brandInk : kind === 'danger' ? '#fff' : t.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled || !!busy, busy: !!busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [s.btn, { backgroundColor: bg, borderColor: t.border, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 }]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={{ color: fg, fontWeight: '700', fontSize: 16 }}>{label}</Text>}
    </Pressable>
  );
}

export function Input({ label, hint, ...p }: TextInputProps & { label: string; hint?: string }) {
  const t = useTheme();
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={{ color: t.text, fontWeight: '600', marginBottom: 6 }}>{label}</Text>
      <TextInput accessibilityLabel={label} accessibilityHint={hint} placeholderTextColor={t.muted} style={[s.input, { color: t.text, borderColor: t.border, backgroundColor: t.surface }]} {...p} />
      {hint ? <Text style={{ color: t.muted, fontSize: 13, marginTop: 4 }}>{hint}</Text> : null}
    </View>
  );
}

export function Notice({ kind = 'info', title, children }: { kind?: 'info' | 'warn' | 'danger' | 'ok'; title?: string; children?: ReactNode }) {
  const t = useTheme();
  const bg = { info: t.infoBg, warn: t.warnBg, danger: t.dangerBg, ok: t.okBg }[kind];
  return (
    <View accessibilityRole={kind === 'danger' ? 'alert' : 'summary'} style={[s.notice, { backgroundColor: bg }]}>
      {title ? <Text style={{ color: t.text, fontWeight: '700', marginBottom: 2 }}>{title}</Text> : null}
      {typeof children === 'string' ? <Text style={{ color: t.text }}>{children}</Text> : children}
    </View>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <Notice kind="danger">{error instanceof Error ? error.message : String(error)}</Notice>;
}

export function Badge({ label, kind }: { label: string; kind?: 'ok' | 'warn' | 'danger' | 'info' }) {
  const t = useTheme();
  const map = { ok: [t.okBg, t.ok], warn: [t.warnBg, t.warn], danger: [t.dangerBg, t.danger], info: [t.infoBg, t.text] } as const;
  const [bg, fg] = map[kind ?? 'info'];
  return (
    <View style={{ backgroundColor: bg, paddingHorizontal: 10, paddingVertical: 2, borderRadius: 999, alignSelf: 'flex-start' }}>
      <Text style={{ color: fg, fontWeight: '600', fontSize: 13 }}>{label}</Text>
    </View>
  );
}

export const usd = (a: string) => {
  const [w = '0', f = ''] = a.split('.');
  return `$${Number(w).toLocaleString('en-US')}.${(f + '00').slice(0, 2)}`;
};

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    fn()
      .then((d) => live && (setData(d), setError(null)))
      .catch((e) => live && setError(e));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, reload: () => setN((x) => x + 1) };
}

export function useAction<A extends unknown[], R>(fn: (...a: A) => Promise<R>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return {
    busy,
    error,
    run: async (...a: A) => {
      setBusy(true);
      setError(null);
      try {
        return await fn(...a);
      } catch (e) {
        setError(e);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
  };
}

const s = StyleSheet.create({
  h1: { fontSize: 26, fontWeight: '800', marginBottom: 12 },
  card: { borderWidth: 1, borderRadius: 14, padding: 16, marginBottom: 14 },
  btn: { minHeight: 48, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, marginVertical: 6 },
  input: { borderWidth: 1, borderRadius: 12, minHeight: 48, paddingHorizontal: 12, fontSize: 16 },
  notice: { borderRadius: 12, padding: 12, marginBottom: 12 },
});
