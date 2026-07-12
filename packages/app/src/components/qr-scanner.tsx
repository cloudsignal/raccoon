import { useEffect, useRef, useState } from 'react';
// jsqr ships as CJS (module.exports = fn) with an ESM-style `export default`
// .d.ts. NodeNext types the default as the namespace, but the value is callable
// at runtime under both the lib build and Bundler test/dev resolution. Bind it
// to the real callable via an explicit function type, preferring `.default`.
import * as jsqr from 'jsqr';
type JsQR = (data: Uint8ClampedArray, width: number, height: number, opts?: jsqr.Options) => jsqr.QRCode | null;
const jsQR: JsQR = ((jsqr as unknown as { default?: JsQR }).default ?? (jsqr as unknown as JsQR));

export function QrScanner(props: { onResult: (text: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const onResultRef = useRef(props.onResult);
  onResultRef.current = props.onResult;

  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Camera is not available on this device.');
      return;
    }
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    const canvas = document.createElement('canvas');

    const tick = (): void => {
      if (stopped) return;
      const video = videoRef.current;
      if (video && video.readyState >= 2) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        if (ctx && canvas.width > 0) {
          ctx.drawImage(video, 0, 0);
          const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(image.data, image.width, image.height);
          if (code?.data) {
            stopped = true;
            stream?.getTracks().forEach((t) => t.stop());
            onResultRef.current(code.data);
            return;
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };

    void navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then((s) => {
        if (stopped) { s.getTracks().forEach((t) => t.stop()); return; }
        stream = s;
        if (videoRef.current) {
          videoRef.current.srcObject = s;
          void videoRef.current.play();
        }
        raf = requestAnimationFrame(tick);
      })
      .catch(() => setError('Camera access was denied.'));

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  if (error) return <p className="text-sm text-ink-soft">{error}</p>;
  return <video ref={videoRef} muted playsInline className="aspect-square w-full rounded-2xl bg-ink object-cover" />;
}
