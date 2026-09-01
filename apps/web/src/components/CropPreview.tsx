import { useEffect, useRef } from "react";

import type { CropBox } from "../types";

interface Props {
  imageUrl: string;
  crop: CropBox;
}

export function CropPreview({ imageUrl, crop }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

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

  return <canvas ref={canvasRef} className="crop-preview-canvas" aria-label="裁剪结果预览" />;
}
