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
import * as migration_20261118_095105_locations from './20261118_095105_locations';
import * as migration_20261118_103105_plans from './20261118_103105_plans';
import * as migration_20261118_112249_organisations from './20261118_112249_organisations';
import * as migration_20261118_144548_add_ons from './20261118_144548_add_ons';
import * as migration_20261118_150954_tax from './20261118_150954_tax';
import * as migration_20261118_152848_alert_subscriptions from './20261118_152848_alert_subscriptions';
import * as migration_20261118_154336_jobs from './20261118_154336_jobs';
import * as migration_20261120_065125_coupons from './20261120_065125_coupons';
import * as migration_20261120_105626_tags_drafts from './20261120_105626_tags_drafts';
import * as migration_20261120_111524_remove_job_tags_areas from './20261120_111524_remove_job_tags_areas';
import * as migration_20261120_122303_location_tree from './20261120_122303_location_tree';
import * as migration_20261120_151343_pages_menus from './20261120_151343_pages_menus';
import * as migration_20261120_203257_applications from './20261120_203257_applications';
import * as migration_20261120_230226_account_import_fields from './20261120_230226_account_import_fields';
import * as migration_20261121_015238_orders from './20261121_015238_orders';
import * as migration_20261121_061136_tenant_add_ons from './20261121_061136_tenant_add_ons';
import * as migration_20261121_153213_credit_ledger from './20261121_153213_credit_ledger';
import * as migration_20261121_163345_xero_invoices from './20261121_163345_xero_invoices';
import * as migration_20261123_001810_view_as_audit_log from './20261123_001810_view_as_audit_log';
import * as migration_20261123_080818_pages_site_settings from './20261123_080818_pages_site_settings';
import * as migration_20261124_044341_form_map_blocks from './20261124_044341_form_map_blocks';
import * as migration_20261124_051310_job_detail_views from './20261124_051310_job_detail_views';
import * as migration_20261124_081812_org_directory from './20261124_081812_org_directory';
import * as migration_20261124_084533_pack_credit_timing from './20261124_084533_pack_credit_timing';
import * as migration_20261124_091222_application_retention from './20261124_091222_application_retention';
import * as migration_20261124_093958_publish_moderation from './20261124_093958_publish_moderation';
import * as migration_20261124_235856_email_core from './20261124_235856_email_core';
import * as migration_20261125_190300_apply_form from './20261125_190300_apply_form';

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
    up: migration_20261118_095105_locations.up,
    down: migration_20261118_095105_locations.down,
    name: '20261118_095105_locations',
  },
  {
    up: migration_20261118_103105_plans.up,
    down: migration_20261118_103105_plans.down,
    name: '20261118_103105_plans',
  },
  {
    up: migration_20261118_112249_organisations.up,
    down: migration_20261118_112249_organisations.down,
    name: '20261118_112249_organisations',
  },
  {
    up: migration_20261118_144548_add_ons.up,
    down: migration_20261118_144548_add_ons.down,
    name: '20261118_144548_add_ons',
  },
  {
    up: migration_20261118_150954_tax.up,
    down: migration_20261118_150954_tax.down,
    name: '20261118_150954_tax',
  },
  {
    up: migration_20261118_152848_alert_subscriptions.up,
    down: migration_20261118_152848_alert_subscriptions.down,
    name: '20261118_152848_alert_subscriptions',
  },
  {
    up: migration_20261118_154336_jobs.up,
    down: migration_20261118_154336_jobs.down,
    name: '20261118_154336_jobs',
  },
  {
    up: migration_20261120_065125_coupons.up,
    down: migration_20261120_065125_coupons.down,
    name: '20261120_065125_coupons',
  },
  {
    up: migration_20261120_105626_tags_drafts.up,
    down: migration_20261120_105626_tags_drafts.down,
    name: '20261120_105626_tags_drafts',
  },
  {
    up: migration_20261120_111524_remove_job_tags_areas.up,
    down: migration_20261120_111524_remove_job_tags_areas.down,
    name: '20261120_111524_remove_job_tags_areas',
  },
  {
    up: migration_20261120_122303_location_tree.up,
    down: migration_20261120_122303_location_tree.down,
    name: '20261120_122303_location_tree',
  },
  {
    up: migration_20261120_151343_pages_menus.up,
    down: migration_20261120_151343_pages_menus.down,
    name: '20261120_151343_pages_menus',
  },
  {
    up: migration_20261120_203257_applications.up,
    down: migration_20261120_203257_applications.down,
    name: '20261120_203257_applications',
  },
  {
    up: migration_20261120_230226_account_import_fields.up,
    down: migration_20261120_230226_account_import_fields.down,
    name: '20261120_230226_account_import_fields',
  },
  {
    up: migration_20261121_015238_orders.up,
    down: migration_20261121_015238_orders.down,
    name: '20261121_015238_orders',
  },
  {
    up: migration_20261121_061136_tenant_add_ons.up,
    down: migration_20261121_061136_tenant_add_ons.down,
    name: '20261121_061136_tenant_add_ons',
  },
  {
    up: migration_20261121_153213_credit_ledger.up,
    down: migration_20261121_153213_credit_ledger.down,
    name: '20261121_153213_credit_ledger',
  },
  {
    up: migration_20261121_163345_xero_invoices.up,
    down: migration_20261121_163345_xero_invoices.down,
    name: '20261121_163345_xero_invoices',
  },
  {
    up: migration_20261123_001810_view_as_audit_log.up,
    down: migration_20261123_001810_view_as_audit_log.down,
    name: '20261123_001810_view_as_audit_log',
  },
  {
    up: migration_20261123_080818_pages_site_settings.up,
    down: migration_20261123_080818_pages_site_settings.down,
    name: '20261123_080818_pages_site_settings',
  },
  {
    up: migration_20261124_044341_form_map_blocks.up,
    down: migration_20261124_044341_form_map_blocks.down,
    name: '20261124_044341_form_map_blocks',
  },
  {
    up: migration_20261124_051310_job_detail_views.up,
    down: migration_20261124_051310_job_detail_views.down,
    name: '20261124_051310_job_detail_views',
  },
  {
    up: migration_20261124_081812_org_directory.up,
    down: migration_20261124_081812_org_directory.down,
    name: '20261124_081812_org_directory',
  },
  {
    up: migration_20261124_084533_pack_credit_timing.up,
    down: migration_20261124_084533_pack_credit_timing.down,
    name: '20261124_084533_pack_credit_timing',
  },
  {
    up: migration_20261124_091222_application_retention.up,
    down: migration_20261124_091222_application_retention.down,
    name: '20261124_091222_application_retention',
  },
  {
    up: migration_20261124_093958_publish_moderation.up,
    down: migration_20261124_093958_publish_moderation.down,
    name: '20261124_093958_publish_moderation',
  },
  {
    up: migration_20261124_235856_email_core.up,
    down: migration_20261124_235856_email_core.down,
    name: '20261124_235856_email_core',
  },
  {
    up: migration_20261125_190300_apply_form.up,
    down: migration_20261125_190300_apply_form.down,
    name: '20261125_190300_apply_form'
  },
];
