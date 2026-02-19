<script lang="ts">
  interface Props {
    number: number;
    size?: number;
  }

  let { number, size = 16 }: Props = $props();

  let displayChar = $derived(String(number));
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  class="number-icon"
  aria-hidden="true"
>
  <rect
    x="2"
    y="2"
    width="20"
    height="20"
    rx="4"
    ry="4"
    stroke="currentColor"
    stroke-width="1.75"
    fill="none"
  />
  <text
    x="12"
    y="12"
    text-anchor="middle"
    dominant-baseline="central"
    fill="currentColor"
    stroke="none"
    font-size="13"
    font-weight="600"
    font-family="system-ui, -apple-system, sans-serif"
  >{displayChar}</text>
</svg>

<style>
  .number-icon {
    display: inline-block;
    vertical-align: middle;
    flex-shrink: 0;
  }
</style>
