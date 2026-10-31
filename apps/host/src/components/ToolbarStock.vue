<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import type { DocumentService, SelectionService } from '@lc/contracts'
import { useAppContext } from '@lc/vue'

const ctx = useAppContext()
const selection = ctx.get<SelectionService>('selection')
const document = ctx.get<DocumentService>('document')

const version = ref(0)
const disposables: Array<{ dispose(): void }> = []

const bump = (): void => {
  version.value += 1
}

const offContribution = ctx.contribution.onDidChange(bump)
const offCommand = ctx.command.onDidChange(bump)
disposables.push(offContribution, offCommand)

if (selection) disposables.push(selection.onDidChange(bump))
if (document) disposables.push(document.onDidChange(bump))

onUnmounted(() => {
  for (const disposable of disposables) disposable.dispose()
  disposables.length = 0
})

const items = computed(() => {
  version.value
  return ctx.contribution
    .list('toolbar')
    .filter((item) => item.value.slot === 'designer.toolbar')
    .map((item) => {
      const command = ctx.command.get(item.value.command)
      return {
        key: `${item.plugin}/${item.value.id}`,
        title: item.value.title,
        command: item.value.command,
        enabled: command ? (command.enabled?.() ?? true) : false,
      }
    })
})

function run(commandId: string): void {
  void ctx.command.execute(commandId)
}
</script>

<template>
  <div class="lc-toolbar">
    <button
      v-for="item in items"
      :key="item.key"
      type="button"
      class="lc-toolbar__button"
      :title="item.title"
      :disabled="!item.enabled"
      @click="run(item.command)"
    >
      {{ item.title }}
    </button>
  </div>
</template>
