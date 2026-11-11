"use client";
import { useEffect, useRef, useState } from "react";
import { Camera, ImagePlus, X } from "lucide-react";
import { Button } from "./ui";

/** Camera and file pixels stay on this device. Only the explicitly confirmed signed token is submitted. */
export function QrReader({ onRead }: { onRead: (value: string) => void }) {
  const video = useRef<HTMLVideoElement>(null); const input = useRef<HTMLInputElement>(null);
  const [camera, setCamera] = useState(false); const [error, setError] = useState<string | null>(null); const [reading, setReading] = useState(false);
  const latestRead = useRef(onRead); latestRead.current = onRead;
  useEffect(() => {
    if (!camera) return;
    let cancelled = false; let stream: MediaStream | null = null; let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { if (timer) clearTimeout(timer); stream?.getTracks().forEach(track => track.stop()); if (video.current) video.current.srcObject = null; };
    void (async () => {
      try {
        const decoder = (await import("jsqr")).default;
        if (cancelled) return;
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false });
        if (cancelled) { stop(); return; }
        const player = video.current; if (!player) { stop(); return; }
        player.srcObject = stream; await player.play();
        const canvas = document.createElement("canvas"); const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("Camera frames are unavailable on this device.");
        const read = () => {
          if (cancelled) return;
          if (player.videoWidth && player.videoHeight) {
            const scale = Math.min(1, 960 / player.videoWidth); canvas.width = Math.round(player.videoWidth * scale); canvas.height = Math.round(player.videoHeight * scale);
            context.drawImage(player, 0, 0, canvas.width, canvas.height);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height); const code = decoder(pixels.data, pixels.width, pixels.height, { inversionAttempts: "dontInvert" });
            if (code) { latestRead.current(code.data); stop(); setCamera(false); return; }
          }
          timer = setTimeout(read, 450);
        };
        read();
      } catch { stop(); if (!cancelled) { setError("The camera is unavailable. Choose a QR image or paste the private handoff link below."); setCamera(false); } }
    })();
    return () => { cancelled = true; stop(); };
  }, [camera]);
  const readImage = async (file: File) => {
    setReading(true); setError(null); const url = URL.createObjectURL(file);
    try {
      if (file.size > 8 * 1024 * 1024 || !file.type.startsWith("image/")) throw new Error("Choose a QR image smaller than 8 MB.");
      const image = new Image(); image.src = url; await image.decode();
      const scale = Math.min(1, 1600 / Math.max(image.width, image.height)); const canvas = document.createElement("canvas"); canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
      const context = canvas.getContext("2d", { willReadFrequently: true }); if (!context) throw new Error("This browser cannot read the image. Paste the private handoff link instead.");
      context.drawImage(image, 0, 0, canvas.width, canvas.height); const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const decode = (await import("jsqr")).default; const result = decode(pixels.data, pixels.width, pixels.height);
      if (!result) throw new Error("No readable QR code was found. Include the full code and its white border, or paste its private link.");
      onRead(result.data);
    } catch (error) { setError(error instanceof Error ? error.message : "This image could not be read."); }
    finally { URL.revokeObjectURL(url); setReading(false); if (input.current) input.current.value = ""; }
  };
  return <div className="qr-reader"><div className="qr-reader-actions"><Button disabled={reading} onClick={() => { setError(null); setCamera(value => !value); }}>{camera ? <X size={16} /> : <Camera size={16} />}{camera ? "Close camera" : "Use camera"}</Button><Button busy={reading} onClick={() => input.current?.click()}><ImagePlus size={16} />Choose QR image</Button><input ref={input} className="visually-hidden" type="file" accept="image/*" aria-label="Choose a QR handoff image" onChange={event => { const file = event.target.files?.[0]; if (file) void readImage(file); }} /></div>{camera && <div className="qr-camera"><video ref={video} muted playsInline aria-label="Live camera for the delivery handoff code" /><span>Keep the full code inside the camera view.</span></div>}{error && <p role="alert" className="payment-error">{error}</p>}<small>Camera frames and chosen images stay on this device.</small></div>;
}
