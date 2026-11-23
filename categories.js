// Shared between the browser and the Node server.
// Each category is a set of Overpass tag filters plus the words people actually say.
export const CATEGORIES = [
  {
    id: 'restaurant', label: 'Restaurants', icon: '🍽️', color: '#e8710a',
    keywords: ['restaurant', 'food', 'dinner', 'lunch', 'eat', 'place to eat', 'coffee', 'pizza', 'breakfast'],
    filters: ['amenity=restaurant', 'amenity=fast_food', 'amenity=cafe', 'amenity=pub']
  },
  {
    id: 'fuel', label: 'Gas stations', icon: '⛽', color: '#1a73e8',
    keywords: ['gas', 'gas station', 'petrol', 'fuel', 'gasoline', 'diesel'],
    filters: ['amenity=fuel']
  },
  {
    id: 'park', label: 'Parks', icon: '🌳', color: '#188038',
    keywords: ['park', 'garden', 'green space', 'playground', 'recreation'],
    filters: ['leisure=park', 'leisure=garden', 'leisure=playground', 'leisure=recreation_ground']
  },
  {
    id: 'grocery', label: 'Groceries', icon: '🛒', color: '#c5221f',
    keywords: ['grocery', 'groceries', 'supermarket', 'market', 'food shop', 'store'],
    filters: ['shop=supermarket', 'shop=convenience', 'shop=greengrocer', 'shop=general']
  },
  {
    id: 'pharmacy', label: 'Pharmacies', icon: '💊', color: '#9334e6',
    keywords: ['pharmacy', 'chemist', 'drugstore', 'medicine'],
    filters: ['amenity=pharmacy']
  },
  {
    id: 'hospital', label: 'Hospitals', icon: '🏥', color: '#d93025',
    keywords: ['hospital', 'clinic', 'doctor', 'emergency', 'medical', 'health'],
    filters: ['amenity=hospital', 'amenity=clinic', 'amenity=doctors', 'amenity=emergency_access_point']
  },
  {
    id: 'atm', label: 'ATMs & banks', icon: '🏧', color: '#0b8043',
    keywords: ['atm', 'bank', 'cash', 'money', 'cash machine'],
    filters: ['amenity=atm', 'amenity=bank']
  },
  {
    id: 'parking', label: 'Parking', icon: '🅿️', color: '#1967d2',
    keywords: ['parking', 'park the car', 'car park', 'garage'],
    filters: ['amenity=parking', 'amenity=parking_entrance']
  },
  {
    id: 'hotel', label: 'Hotels', icon: '🛏️', color: '#7b1fa2',
    keywords: ['hotel', 'motel', 'hostel', 'lodging', 'place to stay', 'guest house'],
    filters: ['tourism=hotel', 'tourism=motel', 'tourism=hostel', 'tourism=guest_house']
  },
  {
    id: 'fountain', label: 'Water fountains', icon: '🚰', color: '#039be5',
    keywords: ['fountain', 'drinking water', 'water', 'drinking fountain', 'water point'],
    filters: ['amenity=drinking_water']
  },
  {
    id: 'toilets', label: 'Public toilets', icon: '🚻', color: '#455a64',
    keywords: ['toilet', 'toilets', 'restroom', 'bathroom', 'wc'],
    filters: ['amenity=toilets']
  },
  {
    id: 'charging', label: 'EV charging', icon: '🔌', color: '#00897b',
    keywords: ['ev', 'charging', 'charger', 'electric car', 'electric vehicle'],
    filters: ['amenity=charging_station']
  },
  {
    id: 'school', label: 'Schools', icon: '🎓', color: '#3949ab',
    keywords: ['school', 'university', 'college', 'kindergarten', 'education'],
    filters: ['amenity=school', 'amenity=university', 'amenity=college', 'amenity=kindergarten']
  },
  {
    id: 'gym', label: 'Gyms', icon: '🏋️', color: '#e53935',
    keywords: ['gym', 'fitness', 'workout', 'sports centre', 'sports center'],
    filters: ['leisure=fitness_centre', 'leisure=sports_centre', 'amenity=gym']
  },
  {
    id: 'cinema', label: 'Cinemas', icon: '🎬', color: '#5e35b1',
    keywords: ['cinema', 'movie', 'movies', 'theater', 'theatre'],
    filters: ['amenity=cinema', 'amenity=theatre']
  },
  {
    id: 'post', label: 'Post offices', icon: '📮', color: '#f9a825',
    keywords: ['post office', 'post', 'mail', 'parcel'],
    filters: ['amenity=post_office', 'amenity=parcel_locker']
  }
];

export const CATEGORY_BY_ID = Object.fromEntries(CATEGORIES.map((category) => [category.id, category]));

// "nearest gas station near me" -> the fuel category.
// Kept on the server too, so the search API can accept plain language.
export function interpretQuery(text) {
  const normalized = String(text || '').toLowerCase().trim();
  if (!normalized) return null;

  const cleaned = normalized
    .replace(/^(what(?:'s| is)?|where(?:'s| is| are)?|find|show me|get me|take me to|i need|i want)\s+(my\s+|the\s+|a\s+|an\s+)?/g, '')
    .replace(/\b(nearest|closest|nearby|near me|around here|in this area|please)\b/g, ' ')
    .replace(/[?.!,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return null;

  let best = null;
  for (const category of CATEGORIES) {
    for (const keyword of category.keywords) {
      if (cleaned === keyword) return category;
      if (cleaned.includes(keyword) && (!best || keyword.length > best.keyword.length)) {
        best = { category, keyword };
      }
    }
  }

  return best ? best.category : null;
}

export const OTHER_CATEGORY = { id: 'other', label: 'Place', icon: '📍', color: '#1a73e8' };

export function categoryForTags(tags = {}) {
  for (const category of CATEGORIES) {
    for (const filter of category.filters) {
      const [key, value] = filter.split('=');
      if (tags[key] === value) return category;
    }
  }
  return OTHER_CATEGORY;
}
