export interface StarterFeed {
  feedUrl: string;
  title: string;
  siteUrl: string;
}

export interface StarterChannel {
  key: string;
  name: string;
  description: string;
  feeds: StarterFeed[];
}

// A deliberately small fixed crawl cost. Curation is server-side so it can be
// adjusted without asking guests to clear their local library.
export const STARTER_CHANNELS: StarterChannel[] = [
  {
    key: 'essays',
    name: 'Essays',
    description: 'Long-form ideas and culture.',
    feeds: [
      { feedUrl: 'https://aeon.co/feed.rss', title: 'Aeon', siteUrl: 'https://aeon.co' },
      {
        feedUrl: 'https://www.themarginalian.org/feed/',
        title: 'The Marginalian',
        siteUrl: 'https://www.themarginalian.org',
      },
      { feedUrl: 'https://lithub.com/feed/', title: 'Literary Hub', siteUrl: 'https://lithub.com' },
    ],
  },
  {
    key: 'tech',
    name: 'Tech',
    description: 'Technology with context.',
    feeds: [
      {
        feedUrl: 'https://feeds.arstechnica.com/arstechnica/index',
        title: 'Ars Technica',
        siteUrl: 'https://arstechnica.com',
      },
      {
        feedUrl: 'https://www.technologyreview.com/feed/',
        title: 'MIT Technology Review',
        siteUrl: 'https://www.technologyreview.com',
      },
      {
        feedUrl: 'https://simonwillison.net/atom/everything/',
        title: "Simon Willison's Weblog",
        siteUrl: 'https://simonwillison.net',
      },
    ],
  },
  {
    key: 'science',
    name: 'Science',
    description: 'Research, discovery, and the natural world.',
    feeds: [
      {
        feedUrl: 'https://www.quantamagazine.org/feed/',
        title: 'Quanta Magazine',
        siteUrl: 'https://www.quantamagazine.org',
      },
      {
        feedUrl: 'https://www.science.org/rss/news_current.xml',
        title: 'Science',
        siteUrl: 'https://www.science.org',
      },
      {
        feedUrl: 'https://www.nasa.gov/news-release/feed/',
        title: 'NASA',
        siteUrl: 'https://www.nasa.gov',
      },
    ],
  },
];

export const STARTER_FEED_URLS = STARTER_CHANNELS.flatMap((channel) =>
  channel.feeds.map((feed) => feed.feedUrl)
);
