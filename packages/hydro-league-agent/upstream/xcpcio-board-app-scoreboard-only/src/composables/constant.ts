import { getRuntimeConfig } from "./runtimeConfig";

export const APP_VERSION = __APP_VERSION__;
export const GITHUB_URL = __GITHUB_URL__;
export const GITHUB_SHA = __GITHUB_SHA__;
export const XCPCIO_HOME = __XCPCIO_HOME__;

export const TITLE_SUFFIX = "Board - XCPCIO";

export const CDN_HOST = computed(() => {
  return getRuntimeConfig().cdnHost ?? "";
});

export const DATA_HOST = computed(() => {
  return getRuntimeConfig().dataHost ?? "";
});

export const DATA_REGION = computed(() => {
  return getRuntimeConfig().dataRegion ?? "";
});
