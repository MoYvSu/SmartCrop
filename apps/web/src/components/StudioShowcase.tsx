import { ArrowDownToLine, ArrowUpRight, Crop, Focus, ImagePlus, Layers3, Monitor, Package, ScanLine, Sparkles } from "lucide-react";

import type { OutputTemplate, SceneType } from "../types";

export function StudioIntro() {
  return (
    <section className="intro-panel" aria-labelledby="studio-title">
      <div className="hero-heading">
        <p className="eyebrow"><span className="eyebrow-line" /> A fresh perspective</p>
        <h1 id="studio-title">每一张照片，<br /><em>都值得好好构图。</em></h1>
        <p className="intro-copy">让 AI 提供灵感，由你决定画面。<br />从一次轻盈的裁剪，发现照片里的另一种可能。</p>
      </div>

      <figure className="hero-showcase">
        <img
          src="/images/alpine-lake.jpg"
          width="1400"
          height="933"
          alt="群山与湖水之间的木屋，展示构图中主体与环境的关系"
          fetchPriority="high"
        />
        <span className="showcase-label"><ScanLine aria-hidden="true" size={14} />构图示意 · 非 AI 推理结果</span>
        <div className="showcase-frame" aria-hidden="true">
          <span className="frame-corner corner-tl" /><span className="frame-corner corner-tr" />
          <span className="frame-corner corner-bl" /><span className="frame-corner corner-br" />
          <div className="showcase-thirds"><i /><i /><i /><i /></div>
          <span className="frame-label">FRAME YOUR STORY</span>
        </div>
        <figcaption className="showcase-caption"><span>LESS DISTRACTION. MORE STORY.</span><strong>留下风景，也留下你的视角。</strong></figcaption>
        <span className="showcase-stamp" aria-hidden="true"><Focus size={23} /></span>
      </figure>

      <div className="hero-notes">
        <span><Layers3 size={15} aria-hidden="true" />三种构图方向</span>
        <span><Crop size={15} aria-hidden="true" />自由精修</span>
        <span><ArrowDownToLine size={15} aria-hidden="true" />原分辨率裁剪</span>
      </div>
    </section>
  );
}

const SCENES = [
  {
    id: "social_cover" as const,
    scene: "social" as const,
    title: "把旅途，装进封面",
    subtitle: "社交封面 · 给风景多一点空间",
    image: "/images/ocean.jpg",
    alt: "傍晚微光下起伏的海浪",
    ratio: "16:9",
    Icon: Layers3,
  },
  {
    id: "presentation" as const,
    scene: "landscape" as const,
    title: "让分享，有画面感",
    subtitle: "演示配图 · 让故事自然展开",
    image: "/images/alpine-lake.jpg",
    alt: "宁静的山间湖泊与岸边木屋",
    ratio: "16:9",
    Icon: Monitor,
  },
  {
    id: "product_main" as const,
    scene: "product" as const,
    title: "让日常，自带主角感",
    subtitle: "商品主图 · 聚焦值得看见的细节",
    image: "/images/coffee.jpg",
    alt: "朋友们手持三杯咖啡相聚的俯视画面",
    ratio: "4:5",
    Icon: Package,
  },
];

interface Props {
  selectedTemplate: OutputTemplate;
  disabled: boolean;
  onChooseTemplate: (template: OutputTemplate, scene: SceneType) => void;
  persistent?: boolean;
}

export function StudioSections({ selectedTemplate, disabled, onChooseTemplate, persistent = false }: Props) {
  const selected = SCENES.find((item) => item.id === selectedTemplate);
  return (
    <>
      <section className="scene-section" id="inspiration" aria-labelledby="scene-title">
        <div className="home-section-heading">
          <div><p className="eyebrow">Made for your moments</p><h2 id="scene-title">为下一次发布，找到好构图。</h2></div>
          <p>选择一个用途，开始你的创作。<br />展示图片仅作灵感参考，分析时使用你上传的照片。</p>
        </div>
        <div className="scene-grid">
          {SCENES.map(({ id, scene, title, subtitle, image, alt, ratio, Icon }) => (
            <button
              type="button"
              className={`scene-card${selectedTemplate === id ? " is-selected" : ""}`}
              key={id}
              disabled={disabled}
              aria-pressed={selectedTemplate === id}
              onClick={() => onChooseTemplate(id, scene)}
            >
              <div className="scene-image">
                <img src={image} alt={alt} width="720" height="480" loading="lazy" />
                <span className="scene-ratio">{ratio}</span>
              </div>
              <div className="scene-card-copy">
                <span className="scene-icon"><Icon aria-hidden="true" size={19} /></span>
                <div><strong>{title}</strong><small>{subtitle}</small></div>
                <ArrowUpRight aria-hidden="true" size={18} />
              </div>
            </button>
          ))}
        </div>
        <p className="template-selection" role="status" aria-live="polite">
          {selected ? `已选择${selected.subtitle.split(" · ")[0]}，发布模板已同步到上方创作区。` : "也可以在创作区选择头像、自由裁剪或自定义比例。"}
        </p>
      </section>

      <section className="guide-section" id="guide" aria-labelledby="guide-title">
        <div className="guide-intro">
          <p className="eyebrow">A simple creative flow</p>
          <h2 id="guide-title">从灵感到成片，<br />只需三步。</h2>
          <p>把繁琐交给工具，<br />把选择留给你。</p>
        </div>
        <ol className="guide-steps">
          <li><span className="guide-number">01</span><div><h3>{persistent ? "导入，建立草稿" : "上传，设定用途"}</h3><p>{persistent ? "登录后导入照片，选择用途与比例，建立独立作品草稿。" : "选一张照片，告诉我们使用场景和目标比例。"}</p></div><ImagePlus aria-hidden="true" size={22} /></li>
          <li><span className="guide-number">02</span><div><h3>{persistent ? "精修，参考按需" : "探索，选择方向"}</h3><p>{persistent ? "直接拖动取景框精修；需要灵感时，再获取 AI 构图参考。" : "在平衡构图、主体优先和环境叙事中选择喜欢的方向。"}</p></div><Sparkles aria-hidden="true" size={22} /></li>
          <li><span className="guide-number">03</span><div><h3>{persistent ? "归档，下载成片" : "精修，下载成片"}</h3><p>{persistent ? "草稿自动保存，完成后归档；也可直接下载当前裁剪图。" : "拖动取景框、微调留白，下载原分辨率裁剪图。"}</p></div><ArrowDownToLine aria-hidden="true" size={22} /></li>
        </ol>
      </section>
      <aside className="creative-note">
        <div><Focus aria-hidden="true" size={29} /><p><strong>好的构图，没有唯一答案。</strong><span>AI 给你新的取景方向，你的感受决定最终画面。</span></p></div>
        <span>YOUR PHOTO. YOUR PERSPECTIVE.</span>
      </aside>
    </>
  );
}
