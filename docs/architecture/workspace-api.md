# 摄影工作室 API v1

日期：2026-10-17。范围：受控共享演示账号、独立项目草稿与归档。旧 `/v1/jobs` 契约保持兼容，不作为项目资源来源。部署与保留边界见 [ADR-0010](../decisions/0010-demo-account-and-durable-projects.md)。

## 身份与公共约定

前端与 API 同源（相同协议、域名及端口）。会话存入 HttpOnly Cookie，前端只在内存持有写入校验令牌，不将密码或令牌存入 localStorage。

| 接口 | 输入／输出 |
| --- | --- |
| `GET /v1/auth/session` | `{user: {id, username, display_name} \| null, csrf_token: string \| null}` |
| `POST /v1/auth/login` | JSON `{username,password}`；返回上述会话并设置 Cookie |
| `POST /v1/auth/logout` | 撤销当前会话、清除 Cookie |

除登录外的写操作要求会话、同源请求及 `X-SmartCrop-CSRF`。`401` 需要登录；`403` 表示来源或写入校验失败；`409` 表示版本冲突或当前操作不支持。错误统一使用 `{detail: string}`（请求字段验证可能为结构化列表）。私有响应禁用缓存。

## 项目操作

账号偏好接口：`GET /v1/preferences` 返回 `{revision,intent,guides}`；初始版本 1。`PUT /v1/preferences` 完整提交相同结构，成功版本加一，过期版本返回 409。用途／比例复用 `AnalysisIntent`；辅助线 `thirds/center/diagonal/safe` 可组合或为空，不允许重复。鉴权与同源写校验同项目操作。详见 [ADR-0012](../decisions/0012-account-defaults-and-project-guide-snapshots.md)。

| 接口 | 行为 |
| --- | --- |
| `POST /v1/projects` | multipart `file` 与场景／比例／发布用途参数，及可选 JSON 字符串 `guides`；未传任何意图字段时继承账号意图，未传辅助线时继承账号辅助线；显式值优先。立即创建独立手动项目，返回 detail，201；不运行模型 |
| `GET /v1/projects` | `state=archived\|draft`、`search`、`limit=1..200`、`offset>=0`；返回 `{items,next_offset}`，末页为 null |
| `GET /v1/projects/{id}` | 返回 detail；若有 AI 任务，同步其独立参考，不更新人工草稿 |
| `PATCH /v1/projects/{id}` | JSON 必填 `revision`，可更新 `title/crop/intent/guides/selected_candidate_id/reference_job_id/selection_reasons/selection_note/selection_explicit`；返回本次写入快照 |
| `POST /v1/projects/{id}/archive` | JSON `{revision}`；生成不可变成片和版本快照，再增加 revision |
| `GET /v1/projects/{id}/versions` | `{items}`；按归档版本倒序返回编辑／意图／参考快照 |
| `POST /v1/projects/{id}/analyze` | 用户主动请求；返回既有 JobResponse，202。活跃任务复用，结果只作为参考 |
| `DELETE /v1/projects/{id}` | 删除专属持久文件与版本，关联任务留不可访问标记，204；临时副本仍按任务保留策略清理 |

`state=archived` 表示已有归档；有新调整的归档项目仍属于 archived，并通过 `has_draft_changes` 标注。服务端 `state=draft` 筛选还包括有待归档调整的项目；当前前端“草稿”筛选只显示未归档项目，“待更新归档”在概览单独计数。页间并发更新可能改变列表顺序，刷新可重新读取，不承诺多页列表是冻结快照。

detail 的稳定字段：`id/title/state/revision/created_at/updated_at/archived_at`，`image_width/image_height`，`intent`，`draft`，`published`，`reference`，`active_job_id`，`has_draft_changes`，四个资源 URL。`source=upload`；`exif` 为拍摄参数白名单对象，可包含 `camera_make/camera_model/lens_model` 字符串与 `focal_length_mm/aperture/exposure_seconds/iso` 数值，缺失项省略。旧作品或无参数图片返回 `{}`。参数只读，不接受 PATCH 修改；下载图像仍去除元数据，详见 [ADR-0013](../decisions/0013-camera-exif-whitelist.md)。

draft 包含裁剪框、辅助线 `guides`、所选候选、参考来源、选择依据与说明。published 为归档时独立快照，包含 `version/created_at/width/height/draft/intent/reference`，并附带与 draft 相同的 `guides`。旧作品缺该字段时固定返回三分线，不跟随账号新偏好。reference 可空，包含任务 ID、状态、候选、原始建议、报告与 `capability_status`，后者区分 Mock 与模型能力状态。没有 AI 报告不阻止保存或归档。

写入必须携带上次成功读取的 revision；冲突后保留本地编辑，不拿最新服务器 revision 自动强行重放。写请求响应来自本次事务内快照，不能带回后继写者的版本并冒充本次结果。

## 图像资源

`GET /v1/projects/{id}/assets/{original|preview|crop|published}` 均校验会话与归属。

- original 为方向规范化、剥离全部元数据后的像素副本，不是上传文件的原始字节。
- crop 可带 `?revision=N`，版本变化则 409，避免下载其他页面后来的草稿。
- published 带 `?version=N` 定位不可变归档版本；项目卡使用服务返回的版本 URL。
- 响应为 `private, no-store`；裁剪与归档作为图片文件下载，不导出 JSON 给普通用户。

项目 URL 不以任务 `/artifacts/` 链接替代。任务过期可使旧 `/v1/jobs/{id}` 返回 404，但不影响项目图片、草稿、归档及已保存的参考。关联任务不能通过旧 `/review` 创建匿名派生任务。

前端声明见 [workspaceApi.ts](../../apps/web/src/workspaceApi.ts)，请求验证见 [projects.py](../../apps/api/src/smartcrop_api/projects.py)；修改字段语义需同步声明、服务与回归测试。
