// Selfie liveness step. The identity vendor's liveness SDK plugs in here and returns a session
// token the server verifies with the vendor (C1-2). The sandbox opens the camera so the flow is
// realistic and returns a sandbox token.
import { useEffect, useRef, useState } from 'react';

export function Liveness({ onDone }: { onDone: (token: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [state, setState] = useState<'idle' | 'camera' | 'done' | 'nocamera'>('idle');
  useEffect(() => () => stream?.getTracks().forEach((t) => t.stop()), [stream]);
  const start = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
      setStream(s);
      setState('camera');
      setTimeout(() => {
        if (video.current) video.current.srcObject = s;
      });
    } catch {
      setState('nocamera');
    }
  };
  const capture = () => {
    stream?.getTracks().forEach((t) => t.stop());
    setState('done');
    onDone(`sandbox-live-${Date.now()}`);
  };
  return (
    <div className="card" style={{ background: 'var(--surface-2)' }}>
      <h3>Selfie check</h3>
      {state === 'idle' && (
        <>
          <p className="small muted">We check it's really you by asking you to look at the camera. Use good light and remove glasses.</p>
          <button type="button" className="btn secondary" onClick={() => void start()}>
            Start selfie check
          </button>
        </>
      )}
      {state === 'camera' && (
        <div className="stack">
          <video ref={video} autoPlay playsInline muted width={240} height={180} style={{ borderRadius: 12, background: '#000' }} aria-label="Camera preview" />
          <button type="button" className="btn" onClick={capture}>
            I'm looking at the camera
          </button>
        </div>
      )}
      {state === 'nocamera' && (
        <div className="stack">
          <p className="small">We couldn't open your camera. Allow camera access, or continue on your phone.</p>
          <button type="button" className="btn secondary" onClick={() => onDone(`sandbox-live-nocam-${Date.now()}`)}>
            Continue (sandbox)
          </button>
        </div>
      )}
      {state === 'done' && <p role="status">Selfie captured.</p>}
    </div>
  );
}
