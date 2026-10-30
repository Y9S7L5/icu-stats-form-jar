import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { HttpClientModule } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';

import { App } from './app';
import { YdwzlTemperatureComponent } from './ydwzl-temperature.component';
import { ToleranceScoreComponent } from './tolerance-score.component';
import { CommitSuicideScoreComponent } from './commit-suicide-score.component';
import { IadScoreComponent } from './iad-score.component';
import { BaetheiScoreComponent } from './baethei-score.component';
import { PatientFallDangerComponent } from './patient-fall-danger.component';
import { HealthEducationComponent } from './health-education.component';
import { WpgmFormComponent } from './wpgm-form.component';
import { EcmoRecordComponent } from './ecmo-record.component';
import { TransfusionRecordComponent } from './transfusion-record.component';
import { TransfusionSystemComponent } from './transfusion-system.component';
import { PiccoRecordComponent } from './picco-record.component';
import { IabpRecordComponent } from './iabp-record.component';
import { TemperatureRecordComponent } from './temperature-record.component';
import { BradenFormComponent } from './braden-form.component';
import { CrrtRecordComponent } from './crrt-record.component';
import { CrrtOrderFormComponent } from './crrt-order-form.component';
import { HljldFormPdfComponent } from './hljld-form-pdf.component';
import { HljldFormPdfNewComponent } from './hljld-form-pdf-new.component';
import { HljldFormNewComponent } from './hljld-form-new.component';
import { HljldFormService } from './hljld-form.service';
import { HljldPdfService } from './hljld-pdf.service';
import { HljldFormNewService } from './hljld-form-new.service';
import { HljldPdfNewService } from './hljld-pdf-new.service';
import { DomSafePipe } from './dom-safe.pipe';
import { HandoverReportComponent } from './handover-report.component';
import { PrintCenterComponent } from './print-center.component';
import { PrintCenterService } from './print-center.service';
import { HandoverReportService } from './handover-report.service';
import { BloodSugarComponent } from './blood-sugar.component';
import { UnplannedExtubationComponent } from './unplanned-extubation.component';
import { PrintPageMultiSelectComponent } from './print-page-multi-select.component';
import { IcuFormViewerComponent } from './icu-form-viewer.component';
import { SggrfkcsFormComponent } from './sggrfkcs-form.component';
import { BedsideRiskCardComponent } from './bedside-risk-card.component';
import { routes } from './app.routes';

@NgModule({
  declarations: [
    App,
    YdwzlTemperatureComponent,
    ToleranceScoreComponent,
    CommitSuicideScoreComponent,
    IadScoreComponent,
    BaetheiScoreComponent,
    PatientFallDangerComponent,
    HealthEducationComponent,
    WpgmFormComponent,
    EcmoRecordComponent,
    TransfusionRecordComponent,
    TransfusionSystemComponent,
    PiccoRecordComponent,
    IabpRecordComponent,
    BradenFormComponent,
    CrrtRecordComponent,
    CrrtOrderFormComponent,
    TemperatureRecordComponent,
    HljldFormPdfComponent,
    HljldFormPdfNewComponent,
    HljldFormNewComponent,
    HandoverReportComponent,
    PrintCenterComponent,
    BloodSugarComponent,
    UnplannedExtubationComponent,
    SggrfkcsFormComponent,
    BedsideRiskCardComponent,
    PrintPageMultiSelectComponent,
    IcuFormViewerComponent,
    DomSafePipe,
  ],
  imports: [
    BrowserModule,
    HttpClientModule,
    FormsModule,
    RouterModule.forRoot(routes),
  ],
  providers: [HljldFormService, HljldPdfService, HljldFormNewService, HljldPdfNewService, HandoverReportService, PrintCenterService],
  bootstrap: [App],
})
export class AppModule {}
