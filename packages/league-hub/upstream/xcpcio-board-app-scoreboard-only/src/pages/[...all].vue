<script setup lang="ts">
import { getRuntimeConfig } from "@board/composables/runtimeConfig";

const dataSource = getRuntimeConfig().dataSource;
</script>

<template>
  <Board :data-source-url="dataSource" />
</template>

<route lang="yaml">
meta:
  layout: board-layout
</route>
