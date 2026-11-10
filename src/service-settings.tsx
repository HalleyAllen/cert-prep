import { useState } from 'react';
import { api } from './model';
import { ErrorBox, Loading, Modal, useAction, useResource } from './ui';

const path = '/api/settings/services';
type ServiceSettings = {
  aiBaseUrl: string;
  aiModel: string;
  hasAiKey: boolean;
  hasTavilyKey: boolean;
  aiReady: boolean;
  searchReady: boolean;
};

function SecretField({ name, label, configured }: { name: string; label: string; configured: boolean }) {
  const [clear, setClear] = useState(false);
  return <div>
    <label>{label}
      <input type="password" name={name} maxLength={4096} autoComplete="new-password" disabled={clear}
        placeholder={configured ? '已保存，留空沿用' : '粘贴服务密钥'} />
    </label>
    {configured && <label className="check-label"><input type="checkbox" name={name + 'Clear'}
      checked={clear} onChange={(event) => setClear(event.target.checked)} />停用此密钥</label>}
  </div>;
}

function ServiceStatus({ ready }: { ready: boolean }) {
  return <span className={ready ? 'pill green' : 'pill'}>{ready ? '配置已填写' : '待配置'}</span>;
}

export function ServiceSettingsDialog({ close, onSaved }: {
  close: () => void;
  onSaved: (settings: Pick<ServiceSettings, 'aiReady' | 'searchReady'>) => void;
}) {
  const { value, error, reload } = useResource<ServiceSettings>(path);
  const action = useAction();
  return <Modal title="服务配置" onClose={() => { if (!action.busy) close(); }}>
    <ErrorBox message={error} retry={reload} />
    {!value && !error && <Loading />}
    {value && <form className="stack config-info" onSubmit={(event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const field = (name: string) => String(form.get(name) ?? '').trim();
      const key = (name: string) => form.has(name + 'Clear') ? null : field(name) || undefined;
      const aiBaseUrl = field('aiBaseUrl');
      const aiModel = field('aiModel');
      void action.run(async () => {
        const saved = await api<ServiceSettings>(path, 'PATCH', {
          aiBaseUrl: aiBaseUrl === value.aiBaseUrl ? undefined : aiBaseUrl,
          aiModel: aiModel === value.aiModel ? undefined : aiModel,
          aiKey: key('aiKey'),
          tavilyKey: key('tavilyKey'),
        });
        onSaved({ aiReady: saved.aiReady, searchReady: saved.searchReady });
      });
    }}>
      <fieldset className="stack" disabled={action.busy}>
        <legend>AI 模型 <ServiceStatus ready={value.aiReady} /></legend>
        <label>兼容接口地址
          <input type="url" name="aiBaseUrl" defaultValue={value.aiBaseUrl} maxLength={2048} spellCheck={false}
            aria-describedby="ai-base-hint" placeholder="https://服务商地址/compatible-mode/v1" />
        </label>
        <p id="ai-base-hint">填写服务商提供的基础地址，通常以 /v1 结尾。</p>
        <label>模型名称
          <input name="aiModel" defaultValue={value.aiModel} maxLength={300} spellCheck={false} placeholder="例如 qwen3.8-27b" />
        </label>
        <SecretField name="aiKey" label="AI 密钥" configured={value.hasAiKey} />
      </fieldset>
      <fieldset className="stack" disabled={action.busy}>
        <legend>联网搜索 · Tavily <ServiceStatus ready={value.searchReady} /></legend>
        <SecretField name="tavilyKey" label="Tavily 搜索密钥" configured={value.hasTavilyKey} />
      </fieldset>
      <p>主动分析或出题时，章节正文会发送给模型服务。联网搜题会将检索词发送给 Tavily。</p>
      <ErrorBox message={action.error} />
      <div className="form-actions">
        <button className="btn secondary" type="button" onClick={close} disabled={action.busy}>取消</button>
        <button className="btn primary" disabled={action.busy}>{action.busy ? '正在保存…' : '保存配置'}</button>
      </div>
    </form>}
  </Modal>;
}
