import { describe, it, expect } from 'vitest';
import { mapPlaceDetailsToReviews } from './googleReviews';

// A representative Places "Place Details" result: a 4.9 aggregate over 187
// reviews, with a mix of 5-star, 4-star, and empty-text snippets.
const sampleResult = {
  rating: 4.9,
  user_ratings_total: 187,
  url: 'https://maps.google.com/?cid=12345',
  reviews: [
    {
      author_name: 'Sarah M.',
      rating: 5,
      text: 'Transformed our home — fast, quiet, spotless.',
      relative_time_description: 'a month ago',
      time: 1700000000,
    },
    {
      author_name: 'David K.',
      rating: 4, // not 5 → must be filtered out of the featured carousel
      text: 'Good work, slightly late.',
      relative_time_description: '2 months ago',
      time: 1699000000,
    },
    {
      author_name: 'Ratings Only',
      rating: 5,
      text: '   ', // whitespace-only → no testimonial, filtered out
      relative_time_description: 'a week ago',
      time: 1701000000,
    },
  ],
};

describe('mapPlaceDetailsToReviews', () => {
  it('keeps Google’s true aggregate rating and total', () => {
    const data = mapPlaceDetailsToReviews(sampleResult)!;
    expect(data.rating).toBe(4.9);
    expect(data.totalReviews).toBe(187);
    expect(data.reviewsUrl).toBe('https://maps.google.com/?cid=12345');
  });

  it('features only 5-star reviews that have text', () => {
    const data = mapPlaceDetailsToReviews(sampleResult)!;
    expect(data.reviews).toHaveLength(1);
    expect(data.reviews[0].name).toBe('Sarah M.');
    expect(data.reviews[0].body).toBe('Transformed our home — fast, quiet, spotless.');
  });

  it('repurposes relative time into the neighborhood slot, with a stable id', () => {
    const data = mapPlaceDetailsToReviews(sampleResult)!;
    expect(data.reviews[0].neighborhood).toBe('a month ago');
    expect(data.reviews[0].id).toBe('g1700000000');
  });

  it('falls back when fields are missing or anonymous', () => {
    const data = mapPlaceDetailsToReviews({
      rating: 5,
      user_ratings_total: 3,
      reviews: [{ rating: 5, text: 'Great!' }],
    })!;
    expect(data.reviewsUrl).toBeUndefined();
    expect(data.reviews[0].name).toBe('Google reviewer');
    expect(data.reviews[0].neighborhood).toBe('Google review');
    expect(data.reviews[0].id).toBe('g-0'); // no time → index-based id
  });

  it('returns null when there are no usable 5-star reviews', () => {
    expect(
      mapPlaceDetailsToReviews({ rating: 4.2, user_ratings_total: 10, reviews: [] }),
    ).toBeNull();
    expect(
      mapPlaceDetailsToReviews({
        rating: 4.2,
        user_ratings_total: 10,
        reviews: [{ rating: 3, text: 'meh' }],
      }),
    ).toBeNull();
  });

  it('returns null when the aggregate is missing or input is empty', () => {
    expect(mapPlaceDetailsToReviews(null)).toBeNull();
    expect(mapPlaceDetailsToReviews(undefined)).toBeNull();
    expect(mapPlaceDetailsToReviews({ reviews: [{ rating: 5, text: 'hi' }] })).toBeNull();
  });
});
