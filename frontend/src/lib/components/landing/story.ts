// The landing page's story: one sample article, followed from the morning it
// arrives to the day it's quoted in the reader's own notes. `StoryStage` draws
// each beat; `ArticleStory` lays the beats out. Every name, site and line here
// is made up, and the stage is labelled as a sample.

export const STORY_ARTICLE = {
  title: 'The Library Is Not a Warehouse',
  site: 'longhand.example',
  author: 'Ines Okafor',
  minutes: 12,
  para1:
    'We keep talking about libraries as if their job were storage: more shelves, more square feet, more of everything kept somewhere.',
  before: 'But storage was never the point. ',
  passage: 'A library isn’t measured by what it holds, but by what its readers can find again.',
  after: ' Everything else is a warehouse with better lighting.',
  closing: 'and that is the only kind of keeping that counts.',
  note: 'This is the opening for my talk.',
  next: {
    title: 'Searchable by Default',
    site: 'fieldnotes.example',
    minutes: 9,
    note: 'Same argument from the reader’s side, with numbers on how often we go looking for old notes.',
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
