type TRgb = [number, number, number];
declare const rgbToHex: (r: number, g: number, b: number) => string;
/**
 * k-means over RGB pixels, used to pull a small palette out of an avatar or
 * banner. Centroids are seeded evenly across the input instead of from the
 * first k pixels, which on a padded image would all be the same corner colour.
 */
declare const kmeans: (pixels: TRgb[], k: number) => TRgb[];
export { kmeans, rgbToHex, type TRgb };
