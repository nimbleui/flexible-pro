import { migrateLegacyLocalStorage } from './migrate'
import { hydratePreferences } from './app-preferences'
import { hydrate as hydrateProjects } from '../projects/project-store'
import { hydrate as hydratePages } from '../pages/page-store'
import { hydrate as hydrateFlows } from '../workflows/flow-store'
import { hydrate as hydrateFunctions } from '../functions/global-functions'
import { hydrate as hydrateComponents } from '../custom-components/custom-components'
import { hydrate as hydrateApis } from '../apis/api-store'
import { hydrate as hydrateApiScopes } from '../apis/api-config'
import { hydrate as hydrateReleases } from '../projects/release-store'
import { hydrate as hydrateDeployLog } from '../projects/release-deploy-log'

/**
 * 挂载前的存储闸门。
 *
 * IndexedDB 只有异步接口，而各 store 与视图沿用的是同步内存 API。为了让「换存储」不波及
 * 任何一处调用方，在 createApp 之前先把整库读进各 store 的 shallowRef：闸门放行后，
 * 所有 `.value` 读取都命中已就绪的内存态，写入再 fire-and-forget 写穿回 IDB。
 *
 * 顺序有依赖，不能全并发：
 * 1. 先跑一次性迁移，把旧 localStorage 搬进 IDB（否则老用户升级后读不到存量）；
 * 2. 灌偏好（主题 / 登录标记），与资产互不依赖；
 * 3. 先 hydrate 项目——发布快照与部署留痕读档时要按 `projects.value` 剔除孤儿，
 *    项目没就位会把它们全判成孤儿丢掉；
 * 4. 其余彼此独立的资产表并发读入；
 * 5. 最后并发读入依赖项目的快照与留痕。
 */
export async function hydrateAll(): Promise<void> {
  await migrateLegacyLocalStorage()
  await hydratePreferences()
  await hydrateProjects()

  await Promise.all([
    hydratePages(),
    hydrateFlows(),
    hydrateFunctions(),
    hydrateComponents(),
    hydrateApis(),
    hydrateApiScopes(),
  ])

  await Promise.all([hydrateReleases(), hydrateDeployLog()])
}
