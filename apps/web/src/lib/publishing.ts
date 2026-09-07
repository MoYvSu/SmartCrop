import type {
  AnalysisIntent,
  CustomRatio,
  OutputTemplate,
  SceneType,
} from "../types";

export interface PublicationPreset {
  id: OutputTemplate;
  name: string;
  description: string;
  aspectRatio: AnalysisIntent["aspect_ratio"];
  ratioLabel: string;
}

export const PUBLICATION_PRESETS: PublicationPreset[] = [
  {
    id: "freeform",
    name: "自由裁剪",
    description: "保留原始分辨率，不锁定比例",
    aspectRatio: "free",
    ratioLabel: "自由",
  },
  {
    id: "avatar",
    name: "头像",
    description: "适合个人资料与账号头像",
    aspectRatio: "1:1",
    ratioLabel: "1:1",
  },
  {
    id: "social_cover",
    name: "社交封面",
    description: "适合宽幅封面与横向内容头图",
    aspectRatio: "16:9",
    ratioLabel: "16:9",
  },
  {
    id: "product_main",
    name: "商品主图",
    description: "适合突出商品并保留展示空间",
    aspectRatio: "4:5",
    ratioLabel: "4:5",
  },
  {
    id: "presentation",
    name: "演示文稿配图",
    description: "适合 16:9 幻灯片与大屏展示",
    aspectRatio: "16:9",
    ratioLabel: "16:9",
  },
  {
    id: "custom",
    name: "自定义比例",
    description: "输入 1:10 至 10:1 之间的宽高比",
    aspectRatio: "custom",
    ratioLabel: "自定义",
  },
];

export function isCustomRatioValid(ratio: CustomRatio): boolean {
  return (
    Number.isInteger(ratio.width)
    && Number.isInteger(ratio.height)
    && ratio.width >= 1
    && ratio.width <= 100
    && ratio.height >= 1
    && ratio.height <= 100
    && ratio.width / ratio.height >= 0.1
    && ratio.width / ratio.height <= 10
  );
}

export function createAnalysisIntent(
  scene: SceneType,
  outputTemplate: OutputTemplate,
  customRatio: CustomRatio,
): AnalysisIntent {
  const preset = PUBLICATION_PRESETS.find((candidate) => candidate.id === outputTemplate);
  if (!preset) throw new Error("未知发布模板");
  return {
    scene,
    aspect_ratio: preset.aspectRatio,
    output_template: outputTemplate,
    custom_ratio: outputTemplate === "custom" ? customRatio : null,
  };
}

export function intentRatioLabel(intent: AnalysisIntent): string {
  if (intent.aspect_ratio === "custom" && intent.custom_ratio) {
    return `${intent.custom_ratio.width}:${intent.custom_ratio.height}`;
  }
  return intent.aspect_ratio === "free" ? "自由比例" : intent.aspect_ratio;
}
