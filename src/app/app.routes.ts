import { Routes } from '@angular/router';
import { DietRouteParserComponent } from './diet-route-parser/diet-route-parser.component';
import { RouteCreatorComponent } from './route-creator/route-creator.component';

export const routes: Routes = [
  { path: '', component: DietRouteParserComponent },
  { path: 'route-creator', component: RouteCreatorComponent },
];
