// Aggregate entry point. Consumers may also deep-import a single module:
//   import { ... } from 'forest-shared-resources/verse'
import * as verse from './verse/index';
import * as licenses from './licenses/index';
import * as userAgents from './user-agents/index';
import * as rbxm from './rbxm/index';

export { verse, licenses, userAgents, rbxm };
