import { truncateCodePoints } from './utils/text';

export interface BookingLink {
  id: string;
  href: string;
}

export const MAX_DESTINATION_CHARS = 120;

// Corroborated portals ship only after one manual browser click each proves
// the template resolves. Flip this after that verification pass.
export const UNVERIFIED_PORTALS_ENABLED = false;

export const buildDestination = (placeName: string, city: string, country: string): string => {
  const seen = new Set<string>();

  const parts: string[] = [];

  for (const raw of [placeName, city, country]) {
    const cleaned = raw.trim().replace(/\s+/g, ' ');

    if (!cleaned) {
      continue;
    }

    const key = cleaned.toLowerCase();

    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    parts.push(cleaned);
  }

  return capDestination(parts.join(', '));
};

export const capDestination = (destination: string): string =>
  truncateCodePoints(destination.trim().replace(/\s+/g, ' '), MAX_DESTINATION_CHARS);

export const buildLinks = (destination: string): BookingLink[] => {
  const capped = capDestination(destination);

  const query = encodeURIComponent(capped);

  const links: BookingLink[] = [
    { id: 'maps', href: `https://www.google.com/maps/search/?api=1&query=${query}` },
    { id: 'hotels', href: `https://www.google.com/travel/hotels?q=${query}&hl=en` },
  ];

  if (UNVERIFIED_PORTALS_ENABLED) {
    links.push(
      { id: 'booking', href: `https://www.booking.com/searchresults.html?ss=${query}` },
      { id: 'getyourguide', href: `https://www.getyourguide.com/s/?q=${query}` },
      { id: 'tripadvisor', href: `https://www.tripadvisor.com/Search?q=${query}` },
      { id: 'expedia', href: `https://www.expedia.com/Hotel-Search?destination=${query}` }
    );
  }

  return links;
};
