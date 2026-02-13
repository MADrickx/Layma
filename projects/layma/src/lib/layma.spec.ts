import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Layma } from './layma';
import { importRdlToLaymaDocument } from './import/rdl/rdl-import';

describe('Layma', () => {
  let component: Layma;
  let fixture: ComponentFixture<Layma>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Layma]
    })
    .compileComponents();

    fixture = TestBed.createComponent(Layma);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('imports tablix with usable size (regression)', () => {
    // Minimal RDL that reproduces the original bug:
    // descendant <Width>/<Height> inside TablixColumn/TablixRow would be picked
    // instead of the tablix' own Width/Height, resulting in a tiny table.
    const xml = `
<Report xmlns="http://schemas.microsoft.com/sqlserver/reporting/2008/01/reportdefinition">
  <PageWidth>21cm</PageWidth>
  <PageHeight>29.7cm</PageHeight>
  <ReportSections>
    <ReportSection>
      <Body>
        <ReportItems>
          <Tablix>
            <Left>10mm</Left>
            <Top>20mm</Top>
            <Width>180mm</Width>
            <Height>100mm</Height>
            <TablixBody>
              <TablixColumns>
                <TablixColumn><Width>10mm</Width></TablixColumn>
                <TablixColumn><Width>10mm</Width></TablixColumn>
              </TablixColumns>
              <TablixRows>
                <TablixRow>
                  <Height>5mm</Height>
                  <TablixCells>
                    <TablixCell>
                      <CellContents>
                        <Textbox><Value>Header</Value></Textbox>
                      </CellContents>
                    </TablixCell>
                    <TablixCell>
                      <CellContents>
                        <Textbox><Value>Header2</Value></Textbox>
                      </CellContents>
                    </TablixCell>
                  </TablixCells>
                </TablixRow>
                <TablixRow>
                  <Height>5mm</Height>
                  <TablixCells>
                    <TablixCell>
                      <CellContents>
                        <Textbox><Value>=Fields!X.Value</Value></Textbox>
                      </CellContents>
                    </TablixCell>
                    <TablixCell>
                      <CellContents>
                        <Textbox><Value>=Fields!Y.Value</Value></Textbox>
                      </CellContents>
                    </TablixCell>
                  </TablixCells>
                </TablixRow>
              </TablixRows>
            </TablixBody>
          </Tablix>
        </ReportItems>
      </Body>
    </ReportSection>
  </ReportSections>
</Report>
`.trim();
    const doc = importRdlToLaymaDocument(xml);

    const tables = doc.elements.filter((el) => el.type === 'table');
    expect(tables.length).toBe(1);

    const t = tables[0];
    // Previously could become tiny (first column width / first row height).
    expect(t.widthMm).toBeGreaterThan(100);
    expect(t.heightMm).toBeGreaterThan(50);
  });

  it('imports parameters as #Param.Name# (regression)', () => {
    const xml = `
<Report xmlns="http://schemas.microsoft.com/sqlserver/reporting/2008/01/reportdefinition">
  <PageWidth>21cm</PageWidth>
  <PageHeight>29.7cm</PageHeight>
  <ReportSections>
    <ReportSection>
      <Body>
        <ReportItems>
          <Textbox>
            <Left>10mm</Left>
            <Top>10mm</Top>
            <Width>50mm</Width>
            <Height>10mm</Height>
            <Value>=Parameters!Facture.Value</Value>
          </Textbox>
        </ReportItems>
      </Body>
    </ReportSection>
  </ReportSections>
</Report>
`.trim();
    const doc = importRdlToLaymaDocument(xml);
    const texts = doc.elements.filter((el) => el.type === 'text');
    expect(texts.length).toBe(1);
    expect(texts[0].text).toBe('#Param.Facture#');
  });
});
