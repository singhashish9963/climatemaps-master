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
}

export const CLIMATE_STORIES: ClimateStory[] = [
  {
    id: 'european-heatwave-2003',
    title: 'European Heatwave 2003',
    description:
      'The 2003 European heat wave was one of the hottest summers on record in Europe. ' +
      'Temperatures exceeded 40°C across France, Spain, and Italy, causing over 70,000 excess deaths. ' +
      'August 2003 saw temperatures 20–30% above seasonal averages in Central and Western Europe, ' +
      'making it a landmark event in climate attribution science.',
    lat: 46.6,
    lon: 2.5,
    zoom: 5,
    variable: ClimateVarKey.T_MAX,
    month: 8,
    dataSource: 'WorldClim / CRU TS',
  },
  {
    id: 'arctic-ice-2012',
    title: 'Arctic Ice Loss 2012',
    description:
      'In September 2012, Arctic sea ice reached its lowest extent ever recorded by satellite — ' +
      'just 3.41 million km², roughly half the 1979–2000 average. This dramatic decline is closely ' +
      'linked to rising Arctic temperatures, which are warming two to three times faster than the global average. ' +
      'The loss of reflective ice accelerates warming through the ice-albedo feedback loop.',
    lat: 78.0,
    lon: 15.0,
    zoom: 3,
    variable: ClimateVarKey.T_MAX,
    month: 9,
    dataSource: 'WorldClim / NSIDC',
  },
  {
    id: 'amazon-drought-2005',
    title: 'Amazon Drought 2005',
    description:
      'The 2005 Amazon drought was one of the worst droughts in 100 years across the western Amazon basin. ' +
      'River levels dropped to historic lows, vast areas of rainforest dried out, and widespread wildfires erupted. ' +
      'The drought was linked to unusually warm Atlantic sea surface temperatures. It raised major concerns ' +
      'about the resilience of the Amazon carbon sink under future warming scenarios.',
    lat: -3.0,
    lon: -60.0,
    zoom: 5,
    variable: ClimateVarKey.PRECIPITATION,
    month: 9,
    dataSource: 'WorldClim / CRU TS',
  },
  {
    id: 'south-asian-monsoon-2009',
    title: 'South Asian Monsoon Failure 2009',
    description:
      'India experienced a severe monsoon deficit in 2009, receiving 23% below normal rainfall — ' +
      'the driest monsoon season since 1972. The weak El Niño suppressed the Indian monsoon circulation, ' +
      'causing widespread crop failure and water shortages affecting hundreds of millions. ' +
      'Monsoon variability is one of the most consequential climate phenomena for South Asia.',
    lat: 22.0,
    lon: 78.0,
    zoom: 5,
    variable: ClimateVarKey.PRECIPITATION,
    month: 7,
    dataSource: 'WorldClim / IMD',
  },
  {
    id: 'siberian-heatwave-2020',
    title: 'Siberian Heatwave 2020',
    description:
      'In June 2020, the Siberian town of Verkhoyansk recorded 38°C — the highest temperature ever ' +
      'documented north of the Arctic Circle. The prolonged heatwave fueled massive wildfires, accelerated ' +
      'permafrost thaw, and caused a catastrophic fuel spill near Norilsk. Scientists determined the event ' +
      'would have been almost impossible without human-caused climate change.',
    lat: 67.5,
    lon: 120.0,
    zoom: 4,
    variable: ClimateVarKey.T_MAX,
    month: 6,
    dataSource: 'WorldClim / ERA5',
  },
  {
    id: 'horn-of-africa-drought-2011',
    title: 'Horn of Africa Drought 2011',
    description:
      'The 2011 East Africa drought was the worst in 60 years, affecting over 13 million people across ' +
      'Somalia, Kenya, Ethiopia, and Djibouti. Failed rains over two consecutive seasons led to famine, ' +
      'mass displacement, and a humanitarian crisis. The drought highlighted how climate extremes ' +
      'compound existing vulnerabilities in food-insecure regions.',
    lat: 4.0,
    lon: 42.0,
    zoom: 5,
    variable: ClimateVarKey.PRECIPITATION,
    month: 4,
    dataSource: 'WorldClim / FEWS NET',
  },
];
