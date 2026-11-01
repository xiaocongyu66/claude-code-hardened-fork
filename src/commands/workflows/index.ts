import { t } from '../../i18n/index.js'
import type { Command } from '../../types/command.js'

const workflows = {
  type: 'local-jsx',
  name: 'workflows',
  description: t('Workflow 监控面板；/workflows <runId> 读取历史完整结果'),
  // 延迟加载面板实现，避免启动时拉入 Ink/React 依赖。
  load: () => import('../../workflow/panel/panelCall.js'),
} satisfies Command

export default workflows
