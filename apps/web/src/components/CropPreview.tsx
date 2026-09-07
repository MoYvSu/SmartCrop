import { Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { CropBox } from "../types";

interface Props {
  imageUrl: string;
  crop: CropBox;
}

const ZOOM_STEPS = [1, 2, 3, 4];

export function CropPreview({ imageUrl, crop }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoomIndex, setZoomIndex] = useState(0);

  useEffect(() => {
    const image = new Image();
    image.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const sourceWidth = crop.width * image.naturalWidth;
      const sourceHeight = crop.height * image.naturalHeight;
      const scale = Math.min(1, 1400 / Math.max(sourceWidth, sourceHeight));
      canvas.width = Math.max(1, Math.round(sourceWidth * scale));
      canvas.height = Math.max(1, Math.round(sourceHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(
        image,
        crop.x * image.naturalWidth,
        crop.y * image.naturalHeight,
        sourceWidth,
        sourceHeight,
        0,
        0,
        canvas.width,
        canvas.height,
      );
    };
    image.src = imageUrl;
    return () => {
      image.onload = null;
    };
  }, [crop, imageUrl]);

  const zoom = ZOOM_STEPS[zoomIndex];
  const canZoomIn = zoomIndex < ZOOM_STEPS.length - 1;
  const canZoomOut = zoomIndex > 0;

  return (
    <div className="crop-preview-viewport" role="group" aria-label="裁剪结果预览">
      <canvas
        ref={canvasRef}
        className="crop-preview-canvas"
        style={{
          transform: `scale(${zoom})`,
          transformOrigin: "0 0",
        }}
      />
      <div className="preview-zoom-controls" aria-label="预览缩放">
        <button
          type="button"
          disabled={!canZoomOut}
          aria-label="缩小预览"
          onClick={() => setZoomIndex((index) => Math.max(0, index - 1))}
        >
          <Minus aria-hidden="true" size={14} />
        </button>
        <span>{zoom}×</span>
        <button
          type="button"
          disabled={!canZoomIn}
          aria-label="放大预览"
          onClick={() => setZoomIndex((index) => Math.min(ZOOM_STEPS.length - 1, index + 1))}
        >
          <Plus aria-hidden="true" size={14} />
        </button>
      </div>
    </div>
  );
}
