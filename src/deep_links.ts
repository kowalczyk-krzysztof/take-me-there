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
    {
      id: 'flights',
      href: `https://www.google.com/travel/flights?q=Flights%20to%20${query}&hl=en`,
    },
    { id: 'hotels', href: `https://www.google.com/travel/hotels?q=${query}&hl=en` },
    {
      id: 'airbnb',
      href: `https://www.airbnb.com/s/${encodeURIComponent(capped.replace(/[/?#]/g, ''))}/homes`,
    },
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

export const MAPS_MAX_WAYPOINTS = 9;
export const MAPS_MAX_URL_CHARS = 2048;

// Multi-stop route link for the itinerary card. Stops arrive in visit order:
// first becomes origin, last becomes destination, the middle becomes
// waypoints. Every name is stripped of pipes, controls, and newlines BEFORE
// encoding (a literal pipe would forge an extra waypoint), capped like any
// destination, and joined with an encoded pipe; the URL cap drops whole
// trailing waypoints, never truncating mid-escape.
export const mapsDirUrl = (stops: string[]): string | null => {
  if (stops.length < 2) {
    return null;
  }

  const clean = (name: string): string => capDestination(name.replace(/[\0-\x1F\x7F|]+/g, ''));
  const origin = clean(stops[0]);
  const destination = clean(stops[stops.length - 1]);

  if (!origin || !destination) {
    return null;
  }

  let middles = stops.slice(1, -1).map(clean).filter(Boolean).slice(0, MAPS_MAX_WAYPOINTS);
  const build = (waypoints: string[]): string => {
    const base =
      'https://www.google.com/maps/dir/?api=1' +
      `&origin=${encodeURIComponent(origin)}` +
      `&destination=${encodeURIComponent(destination)}`;

    if (waypoints.length === 0) {
      return base;
    }

    return `${base}&waypoints=${waypoints.map((stop) => encodeURIComponent(stop)).join('%7C')}`;
  };

  let url = build(middles);

  while (url.length > MAPS_MAX_URL_CHARS && middles.length > 0) {
    middles = middles.slice(0, -1);
    url = build(middles);
  }
  return url.length > MAPS_MAX_URL_CHARS ? null : url;
};
