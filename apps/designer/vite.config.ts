import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { federation } from '@module-federation/vite'
import { networkInterfaces } from 'node:os'

/**
 * 画布模块（Remote）。
 *
 * 只暴露画布模块：`./CanvasModule` 负责页面画布的舞台渲染与能力装载。文档 Realm、
 * 面板、工具栏与状态栏归宿主（apps/host），因此本应用没有 index.html，不独立运行。
 *
 * dev/preview 监听 0.0.0.0，宿主按 `http://<本机 IPv4>:5174/remoteEntry.js` 拉取，
 * dev 与 preview 都必须放开跨源。`server.origin` 取的是宿主入口里同一个地址，
 * 必须与浏览器实际访问的源一致，否则远程 chunk 的绝对 URL 解析不到；
 * 多网卡时用 `LC_DEV_HOST` 指定，算法与 apps/host 保持一致。
 */
function lanIPv4(): string {
  const override = process.env.LC_DEV_HOST
  if (override) return override
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const net of interfaces ?? []) {
      if (!net.internal && net.family === 'IPv4') return net.address
    }
  }
  return 'localhost'
}

const DEV_ORIGIN = `http://${lanIPv4()}:5174`
export default defineConfig({
  plugins: [
    vue(),
    federation({
      name: 'designerCanvas',
      filename: 'remoteEntry.js',
      exposes: {
        './CanvasModule': './src/CanvasModule.vue',
      },
      shared: {
        // 双副本的 Vue 会让远程组件的 vnode 在宿主应用里失效，必须单例
        vue: { singleton: true, requiredVersion: '^3.5.0', eager: true },
      },
      manifest: true,
      // 关掉类型生成：本仓库只有一个根 tsconfig，dts 插件会去找 apps/designer/tsconfig.json 并崩掉；
      // 边界类型由宿主的 src/remotes.d.ts 手写维护
      dts: false,
    }),
  ],
  resolve: {
    dedupe: ['vue'],
  },
  build: {
    // 纯远程模块没有 index.html，Vite 默认入口找不到；以暴露的组件作为构建入口
    rollupOptions: {
      input: './src/CanvasModule.vue',
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5174,
    origin: DEV_ORIGIN,
    cors: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 5174,
    cors: true,
  },
})
