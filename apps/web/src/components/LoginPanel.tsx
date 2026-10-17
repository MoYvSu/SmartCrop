import { useId, useState } from "react";
import { ArrowLeft, ArrowUpRight, Crop, Eye, EyeOff, LoaderCircle, ShieldCheck } from "lucide-react";

import "./workspace-account.css";

export interface LoginPanelProps {
  busy: boolean;
  error: string;
  onSubmit: (username: string, password: string) => void;
  onBack: () => void;
}

export function LoginPanel({ busy, error, onSubmit, onBack }: LoginPanelProps) {
  const [username, setUsername] = useState("demo");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const id = useId();
  return (
    <div className="workspace-account-page">
      <header className="workspace-account-header">
        <span className="brand"><span className="brand-mark"><Crop size={22} aria-hidden="true" /></span><span><strong>SmartCrop</strong><small>美境智剪 · 摄影工作室</small></span></span>
        <button type="button" onClick={onBack} disabled={busy}><ArrowLeft size={17} aria-hidden="true" />返回展示首页</button>
      </header>
      <main className="workspace-account-main" id="main-content" tabIndex={-1}>
        <section className="workspace-login-story" aria-label="摄影工作室">
          <img src="/images/alpine-lake.jpg" alt="山间湖泊与木屋，作为摄影灵感展示素材" width="1400" height="933" />
          <div><p>YOUR PHOTO. YOUR PERSPECTIVE.</p><h2>留住照片，<br />也留住创作的过程。</h2><span>摄影灵感 · 展示素材</span></div>
        </section>
        <section className="workspace-login-form-panel" aria-labelledby={`${id}-title`}>
          <p className="workspace-account-eyebrow">WELCOME TO YOUR CREATIVE SPACE</p>
          <h1 id={`${id}-title`}>进入摄影工作室</h1>
          <p className="workspace-login-intro">登录演示账号，继续创作与整理作品。</p>
          <div className="workspace-shared-library" id={`${id}-shared`}>
            <ShieldCheck size={19} aria-hidden="true" />
            <p><strong>演示账号共用作品库</strong><span>导入的照片与作品会对使用同一账号的人开放，请勿上传私人敏感照片。</span></p>
          </div>
          <form autoComplete="on" aria-describedby={`${id}-shared`} onSubmit={(event) => {
            event.preventDefault();
            if (!busy && username.trim() && password) onSubmit(username.trim(), password);
          }}>
            <label htmlFor={`${id}-username`}>用户名</label>
            <input id={`${id}-username`} name="username" autoComplete="username" autoCapitalize="none"
              spellCheck={false} value={username} required disabled={busy}
              onChange={(event) => setUsername(event.target.value)} />
            <label htmlFor={`${id}-password`}>密码</label>
            <div className="workspace-password-field">
              <input id={`${id}-password`} name="password" type={passwordVisible ? "text" : "password"}
                autoComplete="current-password" value={password} required disabled={busy}
                onChange={(event) => setPassword(event.target.value)} />
              <button type="button" aria-label={passwordVisible ? "隐藏密码" : "显示密码"}
                aria-pressed={passwordVisible} aria-controls={`${id}-password`} disabled={busy}
                onClick={() => setPasswordVisible((value) => !value)}>
                {passwordVisible ? <EyeOff size={19} aria-hidden="true" /> : <Eye size={19} aria-hidden="true" />}
              </button>
            </div>
            {error && <p className="workspace-login-error" role="alert">{error}</p>}
            <button type="submit" className="workspace-login-submit" disabled={busy || !username.trim() || !password} aria-busy={busy}>
              {busy ? <LoaderCircle className="is-spinning" size={18} aria-hidden="true" /> : <ArrowUpRight size={18} aria-hidden="true" />}
              {busy ? "正在登录" : "登录工作室"}
            </button>
          </form>
          <p className="workspace-login-help">演示用户名默认为 demo，密码请向演示维护者获取。</p>
        </section>
      </main>
    </div>
  );
}
