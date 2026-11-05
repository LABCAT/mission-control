import * as migration_20261105_053623_initial from './20261105_053623_initial';
import * as migration_20261105_065255_add_user_names from './20261105_065255_add_user_names';

export const migrations = [
  {
    up: migration_20261105_053623_initial.up,
    down: migration_20261105_053623_initial.down,
    name: '20261105_053623_initial',
  },
  {
    up: migration_20261105_065255_add_user_names.up,
    down: migration_20261105_065255_add_user_names.down,
    name: '20261105_065255_add_user_names'
  },
];
