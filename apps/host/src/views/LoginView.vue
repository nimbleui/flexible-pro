<script setup lang="ts">
/**
 * 登录 / 落地页（科技感视觉演示）。
 *
 * 平台还没有接入控制面与 SSO，这里是一个纯前端的演示入口：输入任意账号即视为登录，
 * 状态只存本机 IndexedDB（app_kv 的 auth-user），登录后跳到工作台。视觉上复用全局网格背景，
 * 再叠加蓝紫双色光晕与玻璃卡片，让首次进入也有「控制台」质感。
 */
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { setAuthUser } from '../storage/app-preferences'

const router = useRouter()
const submitting = ref(false)
const form = reactive({ username: '', password: '' })

function login(): void {
  if (!form.username.trim() || submitting.value) return

  submitting.value = true
  // 演示用：本地标记登录态，不接后端；真实接入时换成控制面 SSO 回调
  setAuthUser(form.username.trim())
  void router.push('/projects')
}
</script>

<template>
  <main class="lc-login">
    <span class="lc-login__aura lc-login__aura--blue" aria-hidden="true" />
    <span class="lc-login__aura lc-login__aura--violet" aria-hidden="true" />

    <section class="lc-login__card" role="form" aria-label="登录">
      <div class="lc-login__brand">
        <span class="lc-login__logo" aria-hidden="true" />
        <span class="lc-login__name">低代码平台</span>
        <span class="lc-login__badge">企业版</span>
      </div>

      <h1 class="lc-login__title">欢迎回来</h1>
      <p class="lc-login__subtitle">
        登录以进入你的应用工作台，拖拽物料、编排流程、绑定接口、一键发布上线。
      </p>

      <form class="lc-login__form" @submit.prevent="login">
        <label class="lc-login__field">
          <span class="lc-login__label">账号</span>
          <input
            v-model="form.username"
            type="text"
            autocomplete="username"
            placeholder="输入任意账号即可体验"
          />
        </label>

        <label class="lc-login__field">
          <span class="lc-login__label">密码</span>
          <input
            v-model="form.password"
            type="password"
            autocomplete="current-password"
            placeholder="演示环境，密码可为空"
          />
        </label>

        <button
          type="submit"
          class="lc-login__submit"
          :disabled="!form.username.trim() || submitting"
        >
          进入工作台
        </button>
      </form>

      <p class="lc-login__hint">演示登录，不校验凭证；登录状态仅保存在本机。</p>
    </section>
  </main>
</template>

<style scoped>
.lc-login {
  position: relative;
  display: grid;
  place-items: center;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 24px;
}

/* 蓝紫双色光晕：与外壳角落光晕同一语言，但更聚拢在卡片背后 */
.lc-login__aura {
  position: absolute;
  width: 520px;
  height: 520px;
  pointer-events: none;
  border-radius: 50%;
  filter: blur(20px);
}

.lc-login__aura--blue {
  top: -180px;
  left: -120px;
  background: radial-gradient(circle, rgba(47, 140, 255, 0.22), transparent 62%);
}

.lc-login__aura--violet {
  bottom: -200px;
  right: -140px;
  background: radial-gradient(circle, rgba(139, 92, 246, 0.2), transparent 62%);
}

.lc-login__card {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: min(420px, 100%);
  padding: 28px 28px 24px;
  border: 1px solid var(--lc-border-strong);
  border-radius: var(--lc-radius-md);
  background: var(--lc-panel-glass);
  box-shadow: var(--lc-shadow);
}

.lc-login__brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.lc-login__logo {
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: linear-gradient(135deg, var(--lc-accent-bright), var(--lc-accent-2));
  box-shadow: 0 0 14px var(--lc-glow);
}

.lc-login__name {
  color: var(--lc-text);
  font-size: 15px;
  font-weight: 600;
}

.lc-login__badge {
  padding: 1px 8px;
  border: 1px solid var(--lc-border);
  border-radius: 999px;
  color: var(--lc-text-secondary);
  font-size: 11px;
}

.lc-login__title {
  margin: 6px 0 0;
  color: var(--lc-text);
  font-size: 22px;
  font-weight: 600;
  letter-spacing: 0.4px;
}

.lc-login__subtitle {
  margin: 0;
  color: var(--lc-text-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.lc-login__form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 2px;
}

.lc-login__field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.lc-login__label {
  color: var(--lc-text-secondary);
  font-size: 11px;
}

.lc-login__field input {
  width: 100%;
  box-sizing: border-box;
  padding: 9px 11px;
  border: 1px solid var(--lc-border);
  border-radius: var(--lc-radius-sm);
  background: var(--lc-surface-sunken);
  color: var(--lc-text);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
}

.lc-login__field input::placeholder {
  color: var(--lc-text-muted);
}

.lc-login__field input:hover {
  border-color: var(--lc-border-strong);
}

.lc-login__field input:focus-visible {
  border-color: var(--lc-accent);
  outline: 2px solid var(--lc-accent-bright);
  outline-offset: 1px;
}

.lc-login__submit {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 38px;
  padding: 0 16px;
  border: 1px solid var(--lc-accent);
  border-radius: var(--lc-radius-sm);
  background: linear-gradient(
    135deg,
    var(--lc-accent-bright),
    var(--lc-accent) 52%,
    var(--lc-accent-2)
  );
  box-shadow: 0 0 18px var(--lc-glow);
  color: var(--lc-on-accent);
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    filter 0.15s ease;
}

.lc-login__submit:hover:not(:disabled) {
  border-color: var(--lc-accent-bright);
  filter: brightness(1.06);
}

.lc-login__submit:disabled {
  border-color: var(--lc-border);
  background: var(--lc-surface-sunken);
  color: var(--lc-text-muted);
  box-shadow: none;
  cursor: not-allowed;
}

.lc-login__hint {
  margin: 2px 0 0;
  color: var(--lc-text-muted);
  font-size: 11px;
  text-align: center;
}

@media (prefers-reduced-motion: reduce) {
  .lc-login__submit {
    transition: none;
  }
}
</style>
