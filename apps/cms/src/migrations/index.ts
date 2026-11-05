import * as migration_20261105_053623_initial from './20261105_053623_initial';

export const migrations = [
  {
    up: migration_20261105_053623_initial.up,
    down: migration_20261105_053623_initial.down,
    name: '20261105_053623_initial'
  },
];
