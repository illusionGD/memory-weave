<template>
  <div class="starry-background" aria-hidden="true">
    <div class="starry-background__stardust"></div>
    <svg class="starry-background__moon" viewBox="0 0 120 120" fill="none">
      <defs>
        <linearGradient
          :id="lightId"
          x1="30"
          y1="20"
          x2="95"
          y2="100"
          gradientUnits="userSpaceOnUse"
        >
          <stop stop-color="#fff6df" />
          <stop offset=".6" stop-color="#eee5ff" />
          <stop offset="1" stop-color="#bdbeef" />
        </linearGradient>
        <mask :id="maskId">
          <circle cx="60" cy="60" r="43" fill="white" />
          <circle cx="42" cy="44" r="43" fill="black" />
        </mask>
      </defs>
      <g :mask="`url(#${maskId})`">
        <circle cx="60" cy="60" r="43" :fill="`url(#${lightId})`" />
        <g fill="#9e99c9" opacity=".14">
          <circle cx="85" cy="63" r="8" />
          <circle cx="63" cy="89" r="5" />
          <circle cx="89" cy="41" r="3" />
          <circle cx="81" cy="84" r="2" />
        </g>
      </g>
    </svg>
  </div>
</template>

<script setup lang="ts">
import { useId } from 'vue';

// 登录与聊天各自使用背景，SVG 引用身份不与路由切换时的另一实例冲突。
const instanceId = useId();
const lightId = `${instanceId}-moon-light`;
const maskId = `${instanceId}-moon-mask`;
</script>

<style scoped lang="scss">
.starry-background {
  position: absolute;
  z-index: -1;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  background:
    radial-gradient(ellipse at 86% 17%, #7f76ba38, transparent 34%),
    radial-gradient(ellipse at 94% 68%, #77598d30, transparent 46%),
    radial-gradient(ellipse at 8% 78%, #354f8f38, transparent 48%),
    linear-gradient(155deg, #10172b 10%, #19203b 56%, #29263f 100%);
}
.starry-background__stardust {
  position: absolute;
  inset: 0;
  background: url('@/assets/images/night-sky.svg') center top / 1440px 1000px repeat;
}
.starry-background__moon {
  position: absolute;
  top: var(--sky-moon-top, 112px);
  right: var(--sky-moon-right, clamp(28px, 6vw, 110px));
  width: var(--sky-moon-size, clamp(84px, 9vw, 128px));
  height: auto;
  opacity: 0.88;
  transform: rotate(-14deg);
  filter: drop-shadow(0 0 16px #e5d5ff40);
}
@media (max-width: 800px) {
  .starry-background__stardust {
    background-size: 1008px 700px;
    background-position: 62% top;
  }
  .starry-background__moon {
    top: var(--sky-moon-top, 100px);
    right: var(--sky-moon-right, 24px);
    width: var(--sky-moon-size, 82px);
    opacity: 0.78;
  }
}
</style>
