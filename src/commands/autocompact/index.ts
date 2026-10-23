import type { Command } from '../../commands.js'
import { t } from '../../i18n/index.js'

const autocompact = {
  type: 'local',
  name: 'autocompact',
  description: t(
    'Show or change the V2 automatic compaction policy (enabled, threshold, reserve, keepRecent, method order)',
  ),
  argumentHint:
    '[on|off|threshold <tokens>|percent <1-99>|reserve <tokens>|keep <tokens>|methods <a,b,c>]',
  supportsNonInteractive: true,
  load: () => import('./autocompact.js'),
} satisfies Command

export default autocompact
