// Expo reads app.json, then hands it to this file (SCL-11, ADM-03). A native
// build takes the county's gateway, organization code and names from the
// environment so one checkout builds for any county without editing app.json:
//   FIELD_API_BASE=https://respond.example-county.gov FIELD_TENANT=westwind \
//   FIELD_PRODUCT_NAME="..." FIELD_COUNTY_NAME="..." pnpm prebuild:ios
// Unset variables keep app.json's values (empty: the app asks at first start).
// The web build ignores apiBase (same origin) and reads /config.json instead.
module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...config.extra,
    apiBase: process.env.FIELD_API_BASE ?? config.extra?.apiBase ?? '',
    tenant: process.env.FIELD_TENANT ?? config.extra?.tenant ?? '',
    productName: process.env.FIELD_PRODUCT_NAME ?? config.extra?.productName ?? '',
    countyName: process.env.FIELD_COUNTY_NAME ?? config.extra?.countyName ?? '',
  },
});
