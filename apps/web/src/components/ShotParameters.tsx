import { Camera } from "lucide-react";
import type { PhotoExif } from "../workspaceApi";

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function decimal(value: number): string {
  return String(Number(value.toFixed(2)));
}
function label(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
function cameraName(exif: PhotoExif): string {
  const make = label(exif.camera_make), model = label(exif.camera_model);
  if (!make || model.toLowerCase().startsWith(make.toLowerCase())) return model || make;
  return [make, model].filter(Boolean).join(" ");
}
export function formatExposure(seconds: unknown): string {
  if (!positive(seconds)) return "";
  return seconds >= 1 ? `${decimal(seconds)} 秒` : `1/${decimal(1 / seconds)} 秒`;
}

export function ShotParameters({ exif, sample = false }: { exif?: PhotoExif; sample?: boolean }) {
  const values = sample ? {} : exif ?? {};
  const rows = [
    ["相机", cameraName(values)],
    ["镜头", label(values.lens_model)],
    ["焦距", positive(values.focal_length_mm) ? `${decimal(values.focal_length_mm)} mm` : ""],
    ["光圈", positive(values.aperture) ? `f/${decimal(values.aperture)}` : ""],
    ["快门", formatExposure(values.exposure_seconds)],
    ["ISO", positive(values.iso) ? String(values.iso) : ""],
  ];
  const available = rows.some(([, value]) => value);
  return <div className="wb-shot-parameters">
    <div className="wb-feature-notice"><Camera size={26} aria-hidden="true" />
      <h2>拍摄参数</h2>
      <p>{available ? "记录这张照片的相机与曝光设置。" : sample
        ? "样例未提供拍摄参数。导入原始照片后，可在这里查看。"
        : "这张照片没有可用的拍摄参数。试试导入相机或手机拍摄的原始照片。"}</p>
    </div>
    {available && <dl className="wb-image-facts wb-exif-facts" aria-label="照片拍摄参数">
      {rows.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value || "未记录"}</dd></div>)}
    </dl>}
  </div>;
}
