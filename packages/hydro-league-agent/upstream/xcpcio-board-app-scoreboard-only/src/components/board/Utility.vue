<script setup lang="ts">
import type { Rank } from "@xcpcio/core";
const props = defineProps<{
  rank: Rank;
}>();

const { t } = useI18n();
</script>

<template>
  <div
    flex flex-col
  >
    <div>
      <div class="mb-2 text-xl font-bold">
        {{ t('utility.export') }}
      </div>

      <div class="border-t border-gray-300 pt-4">
        <Export
          :rank="props.rank"
        />
      </div>
    </div>
  </div>
</template>
