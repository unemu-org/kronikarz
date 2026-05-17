import { useEffect, useState } from 'react';
import { Layer, Image as KonvaImage } from 'react-konva';

interface Props {
  src: string;
  width: number;
  height: number;
  opacity: number;
}

export function ImageLayer({ src, width, height, opacity }: Props): JSX.Element | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    setImg(null);
    const el = new window.Image();
    el.crossOrigin = 'anonymous';
    el.src = src;
    el.onload = () => setImg(el);
    el.onerror = () => setImg(null);
  }, [src]);

  if (!img) return null;
  return (
    <Layer listening={false}>
      <KonvaImage image={img} width={width} height={height} opacity={opacity} />
    </Layer>
  );
}
