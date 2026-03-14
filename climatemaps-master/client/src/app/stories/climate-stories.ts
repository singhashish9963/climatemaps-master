import { ClimateVarKey } from '../utils/enum';

export interface ClimateStory {
  id: string;
  title: string;
  description: string;
  lat: number;
  lon: number;
  zoom: number;
  variable: ClimateVarKey;
  month: number;
  dataSource: string;
  imageUrl: string;
}

export const CLIMATE_STORIES: ClimateStory[] = [
  {
    id: 'european-heatwave-2003',
    title: 'European Heatwave 2003',
    description:
      'The 2003 European heatwave was one of the hottest summers on record, ' +
      'causing over 70,000 excess deaths across Europe. France, Germany, and Italy ' +
      'experienced temperatures exceeding 40 °C for weeks. The event underscored the ' +
      'growing threat of extreme heat under climate change.',
    lat: 46.6,
    lon: 2.5,
    zoom: 5,
    variable: ClimateVarKey.T_MAX,
    month: 8,
    dataSource: 'WorldClim / ERA5',
    imageUrl: 'assets/stories/european-heatwave.svg',
  },
  {
    id: 'arctic-ice-loss-2012',
    title: 'Arctic Ice Loss 2012',
    description:
      'In September 2012, Arctic sea ice shrank to its lowest extent ever recorded — ' +
      'just 3.41 million km², roughly half the 1979–2000 average. The dramatic melt ' +
      'highlighted accelerating polar warming and its cascading effects on global weather ' +
      'patterns and ecosystems.',
    lat: 78.0,
    lon: 15.0,
    zoom: 3,
    variable: ClimateVarKey.T_MAX,
    month: 9,
    dataSource: 'WorldClim / NSIDC',
    imageUrl: 'assets/stories/arctic-ice-loss.svg',
  },
  {
    id: 'amazon-drought-2005',
    title: 'Amazon Drought 2005',
    description:
      'The 2005 Amazon drought was dubbed a "once in a century" event, drying up rivers, ' +
      'devastating communities, and triggering massive wildfires. Large areas of the ' +
      'rainforest shifted from carbon sink to carbon source, releasing billions of tonnes ' +
      'of CO₂ into the atmosphere.',
    lat: -3.0,
    lon: -60.0,
    zoom: 5,
    variable: ClimateVarKey.PRECIPITATION,
    month: 9,
    dataSource: 'WorldClim / GPCC',
    imageUrl: 'assets/stories/amazon-drought.svg',
  },
  {
    id: 'south-asian-monsoon-2009',
    title: 'South Asian Monsoon Failure 2009',
    description:
      'India\'s 2009 monsoon season brought 23% less rainfall than normal — the weakest ' +
      'in nearly four decades. The drought jeopardised food security for hundreds of ' +
      'millions, sharply reduced crop yields, and forced emergency water rationing ' +
      'across multiple states.',
    lat: 22.0,
    lon: 78.0,
    zoom: 4,
    variable: ClimateVarKey.PRECIPITATION,
    month: 7,
    dataSource: 'WorldClim / IMD',
    imageUrl: 'assets/stories/south-asian-monsoon.svg',
  },
  {
    id: 'siberian-heatwave-2020',
    title: 'Siberian Heatwave 2020',
    description:
      'In June 2020 the Siberian town of Verkhoyansk recorded 38 °C — the highest ' +
      'temperature ever measured above the Arctic Circle. Prolonged heat fuelled massive ' +
      'wildfires, accelerated permafrost thaw, and released ancient carbon stores.',
    lat: 67.5,
    lon: 120.0,
    zoom: 4,
    variable: ClimateVarKey.T_MAX,
    month: 6,
    dataSource: 'WorldClim / ERA5',
    imageUrl: 'assets/stories/siberian-heatwave.svg',
  },
  {
    id: 'horn-of-africa-drought-2011',
    title: 'Horn of Africa Drought 2011',
    description:
      'The 2011 East Africa drought was the worst in 60 years, pushing Somalia into ' +
      'famine and affecting over 13 million people across Kenya, Ethiopia, and Djibouti. ' +
      'Two consecutive failed rainy seasons depleted water and pasture, triggering a ' +
      'massive humanitarian crisis.',
    lat: 4.0,
    lon: 42.0,
    zoom: 5,
    variable: ClimateVarKey.PRECIPITATION,
    month: 4,
    dataSource: 'WorldClim / FEWS NET',
    imageUrl: 'assets/stories/horn-of-africa-drought.svg',
  },
];
