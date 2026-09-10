// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
  site: 'https://docs.skyreader.app',
  integrations: [
    starlight({
      title: 'Skyreader',
      description:
        'How to use Skyreader: bring everything you follow into one calm place, read it, and make sense of it.',
      customCss: ['./src/styles/skyreader.css'],
      favicon: '/favicon.svg',
      logo: {
        src: './public/favicon.svg',
        alt: 'Skyreader',
      },
      social: [
        {
          icon: 'external',
          label: 'Open Skyreader',
          href: 'https://skyreader.app',
        },
      ],
      sidebar: [
        {
          label: 'Start here',
          items: [{ slug: 'index', label: 'What is Skyreader?' }, { slug: 'getting-started' }],
        },
        {
          label: 'Guide',
          items: [
            { slug: 'guide/adding-sources' },
            { slug: 'guide/reading' },
            { slug: 'guide/saving-and-highlights' },
            { slug: 'guide/sharing-and-your-linkblog' },
          ],
        },
        {
          label: 'Your account',
          items: [{ slug: 'your-data' }, { slug: 'supporter' }],
        },
        { label: 'FAQ', slug: 'faq' },
      ],
      pagination: false,
      credits: false,
      // The docs are a reading surface; keep Starlight's chrome quiet.
      components: {},
    }),
  ],
});
