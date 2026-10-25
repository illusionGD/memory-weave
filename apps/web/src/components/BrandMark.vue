<template>
  <div class="brand">
    <svg class="brand__symbol" viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <path
        d="M8 30V12a4 4 0 0 1 8 0v16a4 4 0 0 0 8 0V12a4 4 0 0 1 8 0v18"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
      />
      <path
        d="M8 22h24M8 16h24"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        opacity=".45"
      />
    </svg>
    <span class="brand__name">Memory Weave</span>
  </div>
</template>

<style scoped lang="scss">
.brand {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
  color: var(--color-accent);

  &__symbol {
    width: 40px;
    height: 40px;
    flex: 0 0 auto;
  }

  &__name {
    color: var(--color-ink);
    font-family: var(--font-display);
    font-size: 1.4rem;
    letter-spacing: -0.035em;
    white-space: nowrap;
  }
}
</style>
