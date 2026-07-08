import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ImageUp, Loader2, Trash2, ZoomIn } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api } from "./api";
import { Button, Modal } from "./ui";

const VIEW = 288; // on-screen preview
const OUT = 256; // produced image

interface CropState {
  cx: number; // crop center, in source pixels
  cy: number;
  zoom: number; // 1 = the largest inscribed square
}

function srcSide(img: HTMLImageElement, zoom: number) {
  return Math.min(img.naturalWidth, img.naturalHeight) / zoom;
}

function clampCenter(img: HTMLImageElement, s: CropState): CropState {
  const side = srcSide(img, s.zoom);
  const half = side / 2;
  return {
    ...s,
    cx: Math.min(Math.max(s.cx, half), img.naturalWidth - half),
    cy: Math.min(Math.max(s.cy, half), img.naturalHeight - half),
  };
}

function draw(canvas: HTMLCanvasElement, img: HTMLImageElement, s: CropState, size: number) {
  const ctx = canvas.getContext("2d")!;
  const side = srcSide(img, s.zoom);
  ctx.clearRect(0, 0, size, size);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, s.cx - side / 2, s.cy - side / 2, side, side, 0, 0, size, size);
}

export function AvatarEditor({
  hasAvatar,
  onClose,
}: {
  hasAvatar: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [crop, setCrop] = useState<CropState>({ cx: 0, cy: 0, zoom: 1 });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragging = useRef<{ x: number; y: number } | null>(null);

  const done = () => {
    void qc.invalidateQueries({ queryKey: ["me"] });
    onClose();
  };
  const save = useMutation({
    mutationFn: async () => {
      const out = document.createElement("canvas");
      out.width = OUT;
      out.height = OUT;
      draw(out, img!, crop, OUT);
      const blob = await new Promise<Blob>((resolve, reject) =>
        out.toBlob((b) => (b ? resolve(b) : reject(new Error("crop failed"))), "image/jpeg", 0.88),
      );
      return api("/app/api/me/avatar", { method: "PUT", body: blob });
    },
    onSuccess: done,
  });
  const remove = useMutation({
    mutationFn: () => api("/app/api/me/avatar", { method: "DELETE" }),
    onSuccess: done,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas && img) draw(canvas, img, crop, VIEW);
  }, [img, crop]);

  function loadFile(file: File) {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      setImg(image);
      setCrop({ cx: image.naturalWidth / 2, cy: image.naturalHeight / 2, zoom: 1 });
      URL.revokeObjectURL(url);
    };
    image.src = url;
  }

  return (
    <Modal title="Profile picture" onClose={onClose}>
      <div className="space-y-4">
        {!img ? (
          <button
            onClick={() => fileRef.current?.click()}
            className="flex w-full cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-zinc-300 px-4 py-10 text-center transition-colors hover:border-zinc-400 dark:border-zinc-700 dark:hover:border-zinc-500"
          >
            <ImageUp className="size-8 text-zinc-400" />
            <span className="text-sm font-medium">Choose an image</span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              JPEG, PNG or WebP — you will crop it next
            </span>
          </button>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <div
              className="relative touch-none overflow-hidden rounded-xl"
              style={{ width: VIEW, height: VIEW }}
            >
              <canvas
                ref={canvasRef}
                width={VIEW}
                height={VIEW}
                className="cursor-move"
                onPointerDown={(e) => {
                  (e.target as HTMLElement).setPointerCapture(e.pointerId);
                  dragging.current = { x: e.clientX, y: e.clientY };
                }}
                onPointerMove={(e) => {
                  if (!dragging.current || !img) return;
                  const scale = srcSide(img, crop.zoom) / VIEW;
                  const dx = (e.clientX - dragging.current.x) * scale;
                  const dy = (e.clientY - dragging.current.y) * scale;
                  dragging.current = { x: e.clientX, y: e.clientY };
                  setCrop((c) => clampCenter(img, { ...c, cx: c.cx - dx, cy: c.cy - dy }));
                }}
                onPointerUp={() => (dragging.current = null)}
                onWheel={(e) => {
                  if (!img) return;
                  const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
                  setCrop((c) =>
                    clampCenter(img, {
                      ...c,
                      zoom: Math.min(5, Math.max(1, c.zoom * factor)),
                    }),
                  );
                }}
              />
              {/* Circular mask: the area outside the circle is dimmed */}
              <div
                className="pointer-events-none absolute inset-0"
                style={{
                  background:
                    "radial-gradient(circle at center, transparent 49.5%, rgb(0 0 0 / 0.55) 50%)",
                }}
              />
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Drag to reposition, scroll or use the slider to zoom.
            </p>
            <div className="flex w-full max-w-xs items-center gap-2">
              <ZoomIn className="size-4 text-zinc-400" />
              <input
                type="range"
                min={1}
                max={5}
                step={0.01}
                value={crop.zoom}
                onChange={(e) =>
                  img &&
                  setCrop((c) => clampCenter(img, { ...c, zoom: Number(e.target.value) }))
                }
                className="w-full accent-accent"
                aria-label="Zoom"
              />
            </div>
          </div>
        )}

        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) loadFile(f);
            e.target.value = "";
          }}
        />

        <div className="flex items-center gap-3">
          <Button onClick={() => save.mutate()} disabled={!img || save.isPending}>
            {save.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Save picture
          </Button>
          {img ? (
            <Button variant="ghost" onClick={() => fileRef.current?.click()}>
              Choose another image
            </Button>
          ) : null}
          <span className="flex-1" />
          {hasAvatar ? (
            <Button
              variant="subtle"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
            >
              <Trash2 className="size-4" /> Remove picture
            </Button>
          ) : null}
        </div>
        {save.isError ? (
          <p className="text-sm text-red-600 dark:text-red-400">Upload failed — try again.</p>
        ) : null}
      </div>
    </Modal>
  );
}
