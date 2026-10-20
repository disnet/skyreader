/**
 * The Skyreader Dev Log (skyreader-dev.leaflet.pub), whose posts surface in every
 * reader's notification bell as "New in Skyreader" (routes/updates.ts).
 *
 * It is an ordinary standard.site publication, so its posts reach D1 the way any
 * subscribed author's do: the JetstreamPoller watches this author whether or not
 * anyone subscribes to them (`watchedDocumentAuthors`). The author also writes a
 * linkblog and other publications, which is why reads filter on the publication.
 */
export const DEV_LOG_AUTHOR_DID = 'did:plc:4vjd3fe2cgzq5d24j4f3zvar';
export const DEV_LOG_PUBLICATION_URI = `at://${DEV_LOG_AUTHOR_DID}/site.standard.publication/3mde2epyylk2s`;
