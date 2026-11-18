import * as migration_20261105_053623_initial from './20261105_053623_initial';
import * as migration_20261105_063826_heartbeat_and_jobs from './20261105_063826_heartbeat_and_jobs';
import * as migration_20261105_065255_add_user_names from './20261105_065255_add_user_names';
import * as migration_20261105_223955_multi_tenancy from './20261105_223955_multi_tenancy';
import * as migration_20261107_120535_tenancy_modes from './20261107_120535_tenancy_modes';
import * as migration_20261109_171926_site_keys from './20261109_171926_site_keys';
import * as migration_20261118_013433_media_documents_r2 from './20261118_013433_media_documents_r2';
import * as migration_20261118_021548_legacy_password_hash from './20261118_021548_legacy_password_hash';
import * as migration_20261118_044335_account_auth from './20261118_044335_account_auth';
import * as migration_20261118_053124_job_taxonomies from './20261118_053124_job_taxonomies';
import * as migration_20261118_095356_tags_drafts from './20261118_095356_tags_drafts';

export const migrations = [
  {
    up: migration_20261105_053623_initial.up,
    down: migration_20261105_053623_initial.down,
    name: '20261105_053623_initial',
  },
  {
    up: migration_20261105_063826_heartbeat_and_jobs.up,
    down: migration_20261105_063826_heartbeat_and_jobs.down,
    name: '20261105_063826_heartbeat_and_jobs',
  },
  {
    up: migration_20261105_065255_add_user_names.up,
    down: migration_20261105_065255_add_user_names.down,
    name: '20261105_065255_add_user_names',
  },
  {
    up: migration_20261105_223955_multi_tenancy.up,
    down: migration_20261105_223955_multi_tenancy.down,
    name: '20261105_223955_multi_tenancy',
  },
  {
    up: migration_20261107_120535_tenancy_modes.up,
    down: migration_20261107_120535_tenancy_modes.down,
    name: '20261107_120535_tenancy_modes',
  },
  {
    up: migration_20261109_171926_site_keys.up,
    down: migration_20261109_171926_site_keys.down,
    name: '20261109_171926_site_keys',
  },
  {
    up: migration_20261118_013433_media_documents_r2.up,
    down: migration_20261118_013433_media_documents_r2.down,
    name: '20261118_013433_media_documents_r2',
  },
  {
    up: migration_20261118_021548_legacy_password_hash.up,
    down: migration_20261118_021548_legacy_password_hash.down,
    name: '20261118_021548_legacy_password_hash',
  },
  {
    up: migration_20261118_044335_account_auth.up,
    down: migration_20261118_044335_account_auth.down,
    name: '20261118_044335_account_auth',
  },
  {
    up: migration_20261118_053124_job_taxonomies.up,
    down: migration_20261118_053124_job_taxonomies.down,
    name: '20261118_053124_job_taxonomies',
  },
  {
    up: migration_20261118_095356_tags_drafts.up,
    down: migration_20261118_095356_tags_drafts.down,
    name: '20261118_095356_tags_drafts'
  },
];
