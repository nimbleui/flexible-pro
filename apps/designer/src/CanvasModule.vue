<script setup lang="ts">
import { shallowRef } from 'vue'
import type { CanvasContext } from '@lc/contracts'
import type { Context } from '@lc/kernel'
import presetCanvas from '@lc/preset-canvas'
import { CanvasStage } from '@lc/vue'
import { installCanvasCapabilities } from './canvas-plugins'

const props = defineProps<{
  /** 宿主的应用根上下文：画布能力登记与 runtime 空闲等待都通过它 */
  appContext: Context
  /** 宿主创建的 CanvasRealm 上下文；canvas / document / selection 服务已就位 */
  canvasContext: CanvasContext
}>()

/** 画布能力就绪标记；就绪前不渲染舞台，避免出现没有网格、标尺与选择的半成品首帧 */
const ready = shallowRef(false)

/**
 * 装配画布：登记能力插件 → 在当前 CanvasRealm 安装 preset-canvas → 等运行时空闲。
 *
 * 登记必须先于安装，因为预设按 `canvasFeatures` 贡献表决定装哪些能力。
 * 切换文档由宿主换 key 重新挂载本组件，这里不监听 props 变化。
 */
async function openCanvas(): Promise<void> {
  try {
    installCanvasCapabilities(props.appContext)
    props.canvasContext.plugin(presetCanvas)
    await props.appContext.runtime.whenIdle()
    ready.value = true
  } catch (error) {
    console.error('[designer-canvas] 画布能力装载失败', error)
  }
}

void openCanvas()
</script>

<template>
  <CanvasStage v-if="ready" :context="props.canvasContext" />
  <div v-else class="lc-canvas-boot">画布能力装载中…</div>
</template>

<style scoped>
.lc-canvas-boot {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--lc-text-secondary);
  font-size: 13px;
}
</style>
