// The landing page's story: one article, followed from the morning it arrives
// to the day it's quoted in the reader's own notes. `StoryStage` draws each
// beat; `ArticleStory` lays the beats out. The articles are real (the same
// publications as the hero screenshot), quoted briefly; the readers around them,
// their notes and their posts are made up, and the stage is labelled as a sample.

export const STORY_ARTICLE = {
  title: 'Embrace Your Obsessions: Susan Orlean on the Antidote to the Meaninglessness of Life',
  site: 'themarginalian.org',
  url: 'https://www.themarginalian.org/2026/11/14/susan-orlean-orchid-thief/',
  author: 'Maria Popova',
  minutes: 4,
  para1:
    'Every great book, whatever its subject or genre or style, is about one thing only: the eternal question of what gives meaning to our tiny, transient lives.',
  before: '',
  passage:
    'And every answer given, however faintly whispered, points to one thing only: the quality of attention we pay to those lives.',
  after: '',
  closing:
    'a way of centering into our only task here: to fill our allotted days with maximum aliveness.',
  note: 'This is the opening for my talk.',
  next: {
    title: 'Digger Is Good, Notebooks, Please Be Weirder',
    site: 'craigmod.com',
    minutes: 8,
    note: 'The same idea from a notebook: pay that kind of attention to small things on paper.',
  },
} as const;

export interface StoryBeat {
  id: string;
  /** Where in Skyreader the stage is. */
  place: string;
  title: string;
  body: string;
  /** A quieter line under the body: a plan note, or a term explained. */
  aside?: string;
}

export const STORY_BEATS: StoryBeat[] = [
  {
    id: 'arrives',
    place: 'Feeds',
    title: 'It arrives with everything else you follow.',
    body: 'Blogs, newsletters, YouTube channels and links shared by people you follow on Bluesky, in one list, newest first. Nothing slipped in.',
    aside: 'Newsletters by email are part of the Supporter plan.',
  },
  {
    id: 'read',
    place: 'Reader',
    title: 'You read it properly.',
    body: 'Just the words, in the type and size you like. It’s already on your phone, so the train’s dead zone doesn’t matter; anything you do syncs later.',
  },
  {
    id: 'mark',
    place: 'Reader',
    title: 'You mark the line you’ll want again.',
    body: 'Save it, highlight the passage, and write why in the margin, the way you would in a book.',
  },
  {
    id: 'discuss',
    place: 'Discussion',
    title: 'At the end, what others made of it.',
    body: 'Posts, linkblog notes and annotations about this article from around the web. Add your own on your linkblog if you like.',
    aside: 'Turn on From your follows and the people you follow on Bluesky lead it.',
  },
  {
    id: 'connect',
    place: 'Home',
    title: 'Then someone connects it to something new.',
    body: 'A few days later, another reader linked your article to a piece you hadn’t seen, with a note saying why. It shows up on your Home, and one good article leads you to the next.',
    aside:
      'Connections come from Semble, where people collect and link what they read. You don’t need to use it to see them.',
  },
  {
    id: 'review',
    place: 'Review',
    title: 'Weeks later, it comes back to you.',
    body: 'Your review deck deals old highlights back a few at a time, so what you marked resurfaces instead of piling up.',
  },
  {
    id: 'cite',
    place: 'Your notes',
    title: 'Months later, it’s there when you write.',
    body: 'Your highlights and notes land in Obsidian or Zotero with the article’s author, link and date, ready to quote. Or export them all as Markdown.',
    aside: 'Syncing to Obsidian and Zotero is part of the Supporter plan; export is free.',
  },
];
